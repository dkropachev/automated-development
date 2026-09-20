Commit the staged change. It fixes #88: after shutdown() returned, workers still mid-handshake kept
the process alive.
