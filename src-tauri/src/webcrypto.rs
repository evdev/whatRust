//! WebKit's WebCrypto master key, kept out of the login keychain.
//!
//! WhatsApp persists `crypto.subtle` keys in IndexedDB. WebKit wraps those
//! keys with a 16-byte master key. The login keychain item is that key in
//! base64 (24 bytes), labeled "<app> WebCrypto Master Key". This build is
//! ad-hoc signed, so macOS has no stable identity to attach an "Always Allow"
//! decision to and asks for the login password on every read. Each webview
//! reads it, which is why launch asks more than once.
//!
//! The decoded key is copied once into a `0600` file. Before a webview is
//! created, the website data store's private delegate is set to return that
//! file. WebKit then never calls `SecItem` for it. A brand-new install
//! generates the key locally and never creates the keychain item.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{define_class, msg_send, sel, ClassType};
use objc2_foundation::{
    NSBundle, NSData, NSDictionary, NSObject, NSObjectProtocol, NSProcessInfo, NSString, NSUUID,
};
use tauri::{AppHandle, Manager};

/// WebKit's wrapping key is 16 raw bytes. The keychain item holds the base64
/// form of that key, which is 24 bytes, so the blob itself is not the key.
/// A 32-byte raw key is accepted so a longer future key still round-trips.
const KEY_LEN: usize = 16;

const ERR_SUCCESS: i32 = 0;
const ERR_NOT_FOUND: i32 = -25_300;

static KEY: OnceLock<Vec<u8>> = OnceLock::new();

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const std::ffi::c_void;
    static kCFBooleanFalse: *const std::ffi::c_void;
    fn CFRelease(cf: *const std::ffi::c_void);
}

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecClass: *const std::ffi::c_void;
    static kSecClassGenericPassword: *const std::ffi::c_void;
    static kSecAttrAccount: *const std::ffi::c_void;
    static kSecReturnData: *const std::ffi::c_void;
    static kSecReturnAttributes: *const std::ffi::c_void;
    static kSecMatchLimit: *const std::ffi::c_void;
    static kSecMatchLimitOne: *const std::ffi::c_void;
    fn SecItemCopyMatching(
        query: *const std::ffi::c_void,
        result: *mut *const std::ffi::c_void,
    ) -> i32;
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this type has no Drop.
    #[unsafe(super(NSObject))]
    struct WebCryptoDelegate;

    impl WebCryptoDelegate {
        /// Selector spelling is load-bearing: WebKit checks `webCryptoMasterKey:`.
        #[unsafe(method(webCryptoMasterKey:))]
        fn web_crypto_master_key(&self, completion: &DynBlock<dyn Fn(*mut AnyObject)>) {
            let Some(key) = KEY.get().filter(|key| acceptable(key)) else {
                completion.call((std::ptr::null_mut(),));
                return;
            };
            // dataWithBytes: copies. WebKit copies again inside the block, so
            // this NSData only has to live until `call` returns.
            let data = unsafe { NSData::dataWithBytes_length(key.as_ptr().cast(), key.len()) };
            completion.call((Retained::as_ptr(&data) as *mut AnyObject,));
        }
    }

    unsafe impl NSObjectProtocol for WebCryptoDelegate {}
);

/// Load (or import) the master key and point the default data store at it.
/// Account stores are attached again in `attach` just before each webview exists.
pub fn prepare(app: &AppHandle) {
    if !ensure_key(app) {
        return;
    }
    attach(None);
}

/// Point one website data store at the local master key.
/// `None` is the default store (the `default` account).
pub fn attach(store_uuid: Option<[u8; 16]>) {
    if KEY.get().is_none() {
        return;
    }
    if objc2::MainThreadMarker::new().is_none() {
        crate::dlog::log("webcrypto: skipped store attach off the main thread");
        return;
    }
    let Some(cls) = AnyClass::get(c"WKWebsiteDataStore") else {
        crate::dlog::log("webcrypto: WebKit is not loaded");
        return;
    };
    let store: Option<Retained<AnyObject>> = match store_uuid {
        None => unsafe { msg_send![cls, defaultDataStore] },
        Some(bytes) => {
            let uuid = NSUUID::from_bytes(bytes);
            unsafe { msg_send![cls, dataStoreForIdentifier: &*uuid] }
        }
    };
    let Some(store) = store else {
        crate::dlog::log("webcrypto: website data store was missing");
        return;
    };
    let selector = sel!(set_delegate:);
    let responds: Bool = unsafe { msg_send![&*store, respondsToSelector: selector] };
    if !responds.as_bool() {
        crate::dlog::log("webcrypto: data store cannot take a master key");
        return;
    }
    let delegate = delegate();
    let crypto_sel = sel!(webCryptoMasterKey:);
    let has_crypto: Bool = unsafe { msg_send![&*delegate, respondsToSelector: crypto_sel] };
    if !has_crypto.as_bool() {
        crate::dlog::log("webcrypto: master-key delegate method is missing");
        return;
    }
    unsafe {
        let _: () = msg_send![&*store, set_delegate: delegate];
    }
    crate::dlog::log("webcrypto: website data store will not read the login keychain");
}

fn delegate() -> &'static WebCryptoDelegate {
    static DELEGATE: OnceLock<&'static WebCryptoDelegate> = OnceLock::new();
    DELEGATE.get_or_init(|| {
        let obj: Retained<WebCryptoDelegate> =
            unsafe { msg_send![WebCryptoDelegate::class(), new] };
        let ptr = Retained::into_raw(obj);
        // Leaked for the process lifetime. The data store retains it too.
        unsafe { &*ptr }
    })
}

fn ensure_key(app: &AppHandle) -> bool {
    if KEY.get().is_some() {
        return true;
    }
    let Ok(dir) = app.path().app_config_dir() else {
        crate::dlog::log("webcrypto: no config directory");
        return false;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        crate::dlog::log("webcrypto: config directory could not be created");
        return false;
    }
    let account = current_account();
    let path = dir.join(key_file_name(&account));
    if let Some(key) = read_key(&path) {
        let _ = KEY.set(key);
        crate::dlog::log("webcrypto: using saved master key");
        return true;
    }
    // Attributes can be listed without the password. Reading the secret is
    // what raises the dialog, so that happens once, only when the item exists.
    if !keychain_present(&account) {
        return match random_key() {
            Some(key) => remember(&path, key, "webcrypto: created a new master key"),
            None => {
                crate::dlog::log("webcrypto: could not generate a master key");
                false
            }
        };
    }
    crate::dlog::log("webcrypto: asking the login keychain once, so later launches do not");
    match copy_secret(&account) {
        Some(key) => remember(
            &path,
            key,
            "webcrypto: imported master key from the login keychain",
        ),
        None => {
            crate::dlog::log("webcrypto: login keychain import was declined");
            false
        }
    }
}

fn remember(path: &Path, key: Vec<u8>, message: &str) -> bool {
    if let Err(err) = write_key(path, &key) {
        crate::dlog::log(&format!("webcrypto: could not save master key ({err})"));
    }
    let _ = KEY.set(key);
    crate::dlog::log(message);
    true
}

fn keychain_present(account: &str) -> bool {
    let (status, _) = sec_item(account, false);
    if status != ERR_SUCCESS && status != ERR_NOT_FOUND {
        crate::dlog::log(&format!("webcrypto: keychain lookup status {status}"));
        // An unexpected error must not mint a new key over an existing one.
        return true;
    }
    status == ERR_SUCCESS
}

fn copy_secret(account: &str) -> Option<Vec<u8>> {
    let (status, bytes) = sec_item(account, true);
    if status != ERR_SUCCESS {
        crate::dlog::log(&format!("webcrypto: keychain read status {status}"));
        return None;
    }
    let bytes = bytes?;
    match decode_keychain_blob(&bytes) {
        Some(key) => Some(key),
        None => {
            crate::dlog::log(&format!(
                "webcrypto: login keychain master key has unexpected length {}",
                bytes.len()
            ));
            None
        }
    }
}

/// The keychain stores base64 of the raw key (`SerializedCryptoKeyWrapCocoa`).
/// A blob that is already 16 or 32 bytes is the raw key from an older item.
pub(crate) fn decode_keychain_blob(bytes: &[u8]) -> Option<Vec<u8>> {
    if acceptable(bytes) {
        return Some(bytes.to_vec());
    }
    let decoded = base64_decode(bytes)?;
    acceptable(&decoded).then_some(decoded)
}

fn base64_decode(input: &[u8]) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    if input.is_empty() || input.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for chunk in input.chunks_exact(4) {
        let (a, b, c, d) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        if c == b'=' && d != b'=' {
            return None;
        }
        let padding = usize::from(c == b'=') + usize::from(d == b'=');
        let av = value(a)?;
        let bv = value(b)?;
        let cv = if c == b'=' { 0 } else { value(c)? };
        let dv = if d == b'=' { 0 } else { value(d)? };
        out.push((av << 2) | (bv >> 4));
        if padding < 2 {
            out.push((bv << 4) | (cv >> 2));
        }
        if padding < 1 {
            out.push((cv << 6) | dv);
        }
    }
    Some(out)
}

/// `return_data` reads the secret and can raise the login-keychain dialog.
/// Without it, only attributes are requested, which does not.
fn sec_item(account: &str, return_data: bool) -> (i32, Option<Vec<u8>>) {
    let account = NSString::from_str(account);
    let account_obj: &NSObject = unsafe { &*Retained::as_ptr(&account).cast::<NSObject>() };
    let flag = if return_data {
        unsafe { kCFBooleanTrue }
    } else {
        unsafe { kCFBooleanFalse }
    };
    let return_key = if return_data {
        unsafe { kSecReturnData }
    } else {
        unsafe { kSecReturnAttributes }
    };
    // SAFETY: the Security constants are process-lifetime CF objects. NSDictionary
    // retains the values and copies the keys before this function returns.
    let query: Retained<NSDictionary<NSString, NSObject>> = unsafe {
        NSDictionary::from_slices(
            &[
                &*kSecClass.cast::<NSString>(),
                &*kSecAttrAccount.cast::<NSString>(),
                &*return_key.cast::<NSString>(),
                &*kSecMatchLimit.cast::<NSString>(),
            ],
            &[
                &*kSecClassGenericPassword.cast::<NSObject>(),
                account_obj,
                &*flag.cast::<NSObject>(),
                &*kSecMatchLimitOne.cast::<NSObject>(),
            ],
        )
    };
    let mut result: *const std::ffi::c_void = std::ptr::null();
    let status = unsafe { SecItemCopyMatching(Retained::as_ptr(&query).cast(), &mut result) };
    if status != ERR_SUCCESS || result.is_null() || !return_data {
        if !result.is_null() {
            unsafe { CFRelease(result) };
        }
        return (status, None);
    }
    let bytes = unsafe {
        let data = &*result.cast::<NSData>();
        let len = data.length();
        let mut buf = vec![0u8; len];
        if len > 0 {
            if let Some(ptr) = std::ptr::NonNull::new(buf.as_mut_ptr().cast()) {
                data.getBytes_length(ptr, len);
            }
        }
        CFRelease(result);
        buf
    };
    (status, Some(bytes))
}

fn current_account() -> String {
    let bundle = NSBundle::mainBundle().bundleIdentifier();
    let process = NSProcessInfo::processInfo().processName().to_string();
    webkit_account(
        bundle
            .as_deref()
            .map(std::string::ToString::to_string)
            .as_deref(),
        &process,
    )
}

fn random_key() -> Option<Vec<u8>> {
    let mut buf = vec![0u8; KEY_LEN];
    let mut file = std::fs::File::open("/dev/urandom").ok()?;
    std::io::Read::read_exact(&mut file, &mut buf).ok()?;
    Some(buf)
}

pub(crate) fn webkit_account(bundle_id: Option<&str>, process_name: &str) -> String {
    let id = bundle_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(process_name);
    format!("com.apple.WebKit.WebCrypto.master+{id}")
}

pub(crate) fn key_file_name(account: &str) -> String {
    let suffix = account.rsplit('+').next().unwrap_or(account);
    let safe: String = suffix
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!("webcrypto-{safe}.key")
}

fn acceptable(bytes: &[u8]) -> bool {
    bytes.len() == KEY_LEN || bytes.len() == 32
}

pub(crate) fn read_key(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    acceptable(&bytes).then_some(bytes)
}

pub(crate) fn write_key(path: &Path, key: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = temp_path(path);
    let write = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        restrict(&tmp);
        file.write_all(key)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    std::fs::rename(&tmp, path)?;
    restrict(path);
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if path.exists() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("whatrust-webcrypto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keychain_blob_is_base64_of_the_raw_key() {
        // 0x00..=0x0f, the 24-byte form WebKit writes with SecItemAdd.
        let blob = b"AAECAwQFBgcICQoLDA0ODw==";
        assert_eq!(blob.len(), 24);
        assert_eq!(
            decode_keychain_blob(blob).as_deref(),
            Some((0u8..16).collect::<Vec<_>>().as_slice())
        );
        assert_eq!(decode_keychain_blob(&[7u8; 16]).unwrap(), vec![7u8; 16]);
        assert_eq!(decode_keychain_blob(&[9u8; 32]).unwrap(), vec![9u8; 32]);
        assert_eq!(decode_keychain_blob(b"not-a-key"), None);
        assert_eq!(decode_keychain_blob(&[1u8; 24]), None);
    }

    #[test]
    fn account_name_matches_webkit() {
        assert_eq!(
            webkit_account(Some("com.karem.whatrust"), "whatrust"),
            "com.apple.WebKit.WebCrypto.master+com.karem.whatrust"
        );
        assert_eq!(
            webkit_account(None, "whatrust"),
            "com.apple.WebKit.WebCrypto.master+whatrust"
        );
        assert_eq!(
            webkit_account(Some("  "), "whatrust"),
            "com.apple.WebKit.WebCrypto.master+whatrust"
        );
        assert_eq!(
            key_file_name("com.apple.WebKit.WebCrypto.master+com.karem.whatrust"),
            "webcrypto-com.karem.whatrust.key"
        );
    }

    #[test]
    fn key_file_round_trips_and_is_owner_only() {
        let dir = scratch();
        let path = dir.join("webcrypto-com.karem.whatrust.key");
        let key = vec![7u8; KEY_LEN];
        write_key(&path, &key).unwrap();
        assert_eq!(read_key(&path).as_deref(), Some(key.as_slice()));
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::write(&path, [1, 2, 3]).unwrap();
        assert_eq!(read_key(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
