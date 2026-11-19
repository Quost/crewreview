# Security

Does it hold up against someone who wants it to fail, not just against a polite user?

Look for:

- Injection: SQL, shell, path, template, header, log or prompt injection from anything a user or another system controls.
- Access control: new routes, jobs or queries that skip authentication or authorization, or check the wrong owner.
- Secrets: keys, tokens or passwords in code, logs, errors, URLs or client bundles.
- Unsafe defaults: permissive CORS, disabled TLS checks, debug modes, broad file permissions, open redirects.
- Deserialization, file upload and archive extraction without limits or type checks.
- Cryptography: home-made crypto, weak or misused algorithms, predictable randomness for security purposes.
- Personal data: data collected, logged or exposed without need; deletion that leaves copies behind.
- Supply chain: new dependencies, scripts or CI steps that run untrusted code or pin nothing.

Show how an attacker would reach the problem. If you can't trace a path from an input to the weakness, use confidence "low".
