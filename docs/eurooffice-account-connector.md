# EuroOffice account connector

The optional connector adds an account-specific EuroOffice card to the app settings. Each Native account owns its activation and files; the installation administrator configures one editor URL and JWT key. The Agent plugin's enabled flag does not control Office.

Set `EUROOFFICE_GATEWAY_URL` on the webmail server to the gateway's HTTPS origin, without a path or credentials. Enable the installation's general add-ons feature gate. Configure the gateway's `STALWART_ORIGIN`, `EMBED_ORIGINS` and `INSTALLATION_ADMIN_USERS` for this host. The gateway's [installation and connector contract](https://github.com/illuwa-soft/euro-office-stalwart-gateway/blob/main/docs/host-connector.md) owns its schema and migration.

## Identity and lifecycle

- Settings use the authenticated JMAP `Session.username`, server origin and explicit cookie slot. The server selects only that slot and forwards its trusted Native credential. Owner IDs and expected subjects reject mismatches; they do not authenticate a caller.
- `/api/eurooffice/view/{slot}/{owner}/…` proxies only admitted app routes. It strips incoming Office cookies and browser authorization, refuses upstream redirects, and does not relay Set-Cookie. The gateway revalidates Native access on every private request.
- Office state uses account/slot/subject/origin-scoped TanStack Query entries. The local form clears key input after every save result. It does not retain the key as a mutation variable or persisted plugin setting.
- Account switching, logout, disabling Office, and owned navigation wait for the exact frame's confirmed close. A refused close or timeout retains the document. Late mutations recheck the current account after the wait. Forced authentication revocation does not wait for the renderer.
- Resolved apps omit the old `admin-app-eurooffice-workspace` bookmark. The connector does not activate the separate 0.8.0 plugin. Native Files source and the standard inline sandbox remain the selected upstream versions.

## Verification

```sh
npm exec -- vitest run lib/eurooffice components/settings/__tests__/eurooffice-settings.test.tsx components/layout/__tests__/office-navigation.test.tsx hooks/__tests__/use-sidebar-apps.test.tsx --maxWorkers=1
npm run typecheck
npm run build
EUROOFFICE_PRODUCT_ROOT=/absolute/euro-office-stalwart-gateway node scripts/office-connector-check.mjs
```

The connector check needs the built gateway and webmail, Node, OpenSSL, and Chrome. Set `CHROME_EXECUTABLE` when Chrome is not at the macOS default location. It starts owned loopback servers with isolated test-only keys and config. Real Next routes and cookie decryption connect to real Worker/D1; the harness controls Native and the parent shell. It does not log into a production account. Results are under ignored `.octocode/tmp/office-connector/`.

Deployment requires a reviewed host image/source profile, the gateway migration and administrator selection, backups, and a separate production acceptance. Close existing ambient-cookie Office frames before replacing the old global bookmark. An already loaded older client is not automatically rebound to the new account protocol.
