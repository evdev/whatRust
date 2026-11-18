# Windows installers

The checked-in setup files install this fork for the current Windows user.
Choose `arm64` for a Windows-on-ARM PC or `x64` for an Intel/AMD PC. The
setup executable is unsigned; Windows may ask you to confirm that you trust it.
ARM64 local transcription requires the separately installed GenieX CLI and Q8
model, which the app's Transcription settings explain.

When publishing a new build, build the NSIS installer on each target
architecture with `cargo tauri build --bundles nsis` (or provide the matching
`--target`), replace both setup files here, regenerate `SHA256SUMS`, and update
the filenames and hashes in `install.ps1` and the links in the main README in
the same commit. The Windows installer check runs the checked-in installers on
both architectures in GitHub Actions.
