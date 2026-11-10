# @4fu/dsh-standard-plus

A DeepSeek Harness bundle that replaces DSH's four shipped Web agent modes
(Standard, PTC, Minimal and Creator) with one Standard mode that also carries
Creator mode's Cordis tools: `cordis_inspect_list`, `cordis_inspect_query`,
`plugin_manager`, and the four Cordis skills.

It is a patch-layer bundle. It installs no JavaScript and adds no DSH runtime
dependency to the profile.

## Install

Requires DeepSeek Harness `dsh-v0.2.2-rc.1` and Node.js 24.9 or newer.

```bash
dsh plugin --profile web add @4fu/dsh-standard-plus@2026.1110.0
```

Restart DSH. The mode picker now shows one **Standard mode**; a session created
under it has the Cordis tools and skills.

## Undo

```bash
dsh plugin --profile web remove @4fu/dsh-standard-plus
```

Restart DSH. The four shipped modes return, and sessions recorded under
`standard` resolve to DSH's own Standard mode again.

## What it does not touch

- It does not touch another bundle's preset. `@4fu/dsh-arbor-bundle` stays
  selectable beside the new Standard mode.
- It does not add a second copy of any `@deepseek-ai/dsh-*` or Cordis package.
- It writes no user configuration and makes no network request.

## Old sessions

Sessions recorded as `standard` keep working. A session recorded as `ptc`,
`minimal` or `cordis` that has already started a turn cannot resume while the
bundle is installed because those presets are no longer declared; removing the
bundle restores them. The full
behavior, including the settings default and the exact failure, is in
[the repository's mode notes](https://github.com/4fuu/dsh-standard-plus/blob/main/docs/modes.md).

## DSH pin

This bundle is built for exactly `@deepseek-ai/dsh@0.2.2-rc.1`. Its
`engines.dsh` is that exact version, and its patch is generated from that
version's own `preset-standard` and `preset-cordis` declarations. A different
DSH version is unsupported.

## License

MIT.
