# Fork maintenance constraints

The operator retired these proposals on 2026-10-30, including their downstream
implementations:

- [#1343](https://github.com/bulwarkmail/webmail/issues/1343): routing all attachment downloads through a new Bulwark/Next server streaming endpoint.
- [#1391](https://github.com/bulwarkmail/webmail/issues/1391): host-owned external embedded views beside plugin sandboxes.
- [#1415](https://github.com/bulwarkmail/webmail/issues/1415): host-signed companion identities and background native-file delegation using credentials retained on the webmail host.

Do not restore, reimplement, repackage, rename or repropose these features unless
the operator explicitly reverses this decision. Follow-up cleanup must not add
replacement implementations of the retired capabilities.

Maintain normal plugin sandbox UI, existing credential-proxy behavior and native
file operations independently. Accepted upstream contributions are frame-scoped
progress toasts (#1413), composer read APIs and quick-reply actions (#1369), and
setting-free account reauthentication (#1361).
