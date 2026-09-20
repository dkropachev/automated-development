File a bug for this. On widget-service 2.3.1 (Linux/6.12.x, Python 3.12), after `PoolManager.shutdown()`
returns the process stays alive when any worker was still mid-handshake — a connect/shutdown race.
`python -c 'import widget.pool.manager as m; p = m.PoolManager(2); p.start(); p.shutdown()'`
hangs; `py-spy dump` shows the worker threads still in `Worker.connect`. Version 2.2.0 exits cleanly.
