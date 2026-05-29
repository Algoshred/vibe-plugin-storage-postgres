# @vibecontrols/vibe-plugin-storage-postgres

<!-- VIBECONTROLS_OSS_BODY_START -->

> Full-parity PostgreSQL storage provider with AES-256-GCM encryption — share state across multiple agents.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-storage-postgres
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-storage-postgres
# or
npm install @vibecontrols/vibe-plugin-storage-postgres
```

## How it works

Storage **providers** implement the `AgentDatabase` contract from `@vibecontrols/vibe-plugin-storage` (meta) so the agent's persistence layer is pluggable across embedded and server backends.

This package is a **provider** registered against the `@vibecontrols/vibe-plugin-storage` meta plugin. Install the meta plugin first; this provider plugs into it.

## Upstream

- **PostgreSQL** — <https://www.postgresql.org/>

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-storage-postgres>
- Source: <https://github.com/algoshred/vibe-plugin-storage-postgres>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/storage-postgres>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **PostgreSQL** — <https://www.postgresql.org/>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
