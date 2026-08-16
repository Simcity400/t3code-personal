@echo off
rem Wrapper so CodexSessionRuntime can spawn the mock peer on Windows. The
rem runtime always passes "app-server" first; discard it and run the peer.
shift
node "%T3_CODEX_COLLAB_PEER%" %*
