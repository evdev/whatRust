# Installers

The macOS file is an unsigned Apple Silicon disk image,
`whatRust_0.6.16_aarch64.dmg`. Open it, drag whatRust into Applications, and
clear the quarantine flag once with
`xattr -dr com.apple.quarantine /Applications/whatRust.app`.

## Windows installers

The checked-in setup files install this fork for the current Windows user.
Choose `arm64` for a Windows-on-ARM PC or `x64` for an Intel/AMD PC. The
setup executable is unsigned; Windows may ask you to confirm that you trust it.
The wizard offers to install the local transcription tools. ARM64 installs
GenieX CLI and Qwen3-ASR Q8 (about 1.2 GiB total; requires a supported
Snapdragon NPU). x64 installs FluidVoice, which still needs its own model setup
and local API enabled. Existing tools and models are not replaced. Silent
installs skip this optional download unless `/TRANSCRIBE` is specified.

When publishing a new build, build the NSIS installer on each target
architecture with `cargo tauri build --bundles nsis` (or provide the matching
`--target`), replace both setup files here, regenerate `SHA256SUMS`, and update
the filenames and hashes in `install.ps1` and the links in the main README in
the same commit. The Windows installer check runs the checked-in installers on
both architectures in GitHub Actions.
