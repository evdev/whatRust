; Resolved while this include is read, so the script can be embedded by NSIS
; regardless of whether the build uses a target-specific Cargo directory.
!define TRANSCRIPTION_SETUP_SOURCE "${__FILEDIR__}\transcription-setup.ps1"
