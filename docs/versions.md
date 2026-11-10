# Versions and compatibility

This bundle is a DSH integration, not a DSH release. It is built and checked
against exactly one DeepSeek Harness version and relies on row names, preset
declaration semantics and three plugin rows from that version's Web bundle.

## The pin

| Component | Pin | Where it comes from |
| --- | --- | --- |
| DeepSeek Harness | tag `dsh-v0.2.2-rc.1` | npm `@deepseek-ai/dsh@0.2.2-rc.1` and the companion `@deepseek-ai/dsh-*` packages at `0.2.2-rc.1` |
| `@4fu/dsh-standard-plus` | `2026.1110.0` | this repository, `packages/dsh-standard-plus` |
| Node.js | `>=24.9.0` (developed on Node 26) | `engines` in both manifests |
| pnpm | `11.28.5` | `packageManager` in the root manifest; `.agents/setup` installs that exact version |

The generated patch is copied from
`@deepseek-ai/dsh-web-app@0.2.2-rc.1`'s own
`presets/standard.patch.yml` and `presets/cordis.patch.yml`. The generator reads
those files from the checkout's `devDependencies`, so the pinned package is the
source of truth, not a copy committed by hand.

## What a published package depends on

Nothing at runtime. The bundle is a package with a manifest, `engines.dsh`, one
patch file and a README. Every `@deepseek-ai/dsh-*` row its patch names is
mounted from the DSH installation by DSH's own resolution, exactly as the
shipped Web presets mount them. The package has no `dependencies` and no
`peerDependencies`, so `dsh plugin add` installs no package into the profile
beyond the bundle itself.

`@deepseek-ai/dsh-web-app` is a root **devDependency** only. It lets
`scripts/generate-patch.mjs` read the pinned preset files and lets
`pnpm check:patch` fail when the committed patch no longer matches them. A
profile never sees it, and the profile check asserts the profile holds no second
copy of a DSH runtime package.

## What happens on a different DSH version

Nothing in this repository promises compatibility with another DSH version.

- **The patch is not generated for it.** A newer or older `dsh-web-app` may
  declare different preset rows, plugin rows or expressions. `pnpm check:patch`
  regenerates from the installed package and fails against the committed patch,
  so a version bump is a visible port, never a silent copy.
- **DSH refuses the bundle.** `engines.dsh` is the exact pin. A profile bundle
  whose requirement the runtime does not satisfy is skipped (and reported) by
  the profile loader unless the profile records a version exemption. The
  profile then keeps the shipped four modes and the bundle's patch is not
  composed.
- **The mode identity can drift.** Sessions record `config.id: standard`. If a
  later DSH renames or removes the shipped `standard` preset, the declaration
  still records `standard`, but the built-in display copy and the surrounding
  preset semantics may change.
- **The tools and skills can move.** The bundle names `tool-cordis`,
  `plugin-manager/tools`, `plugin-market/tools` and `skill-filesystem`, and
  Creator mode's `customSkillDirs` expression. A DSH release that renames a
  package, changes the skill directory, or moves the profile condition can make
  a row fail to activate; the profile check's tool and skill assertions fail
  first.

## How the pin is checked

- `pnpm check:pin` reads the root and package manifests. It checks every
  `engines.dsh`, the exact DSH devDependency, the bundle's `dsh.bundle.patch`
  file and its presence in `files`, the `YYYY.MMDD.REVISION` version shape, and
  that the published package declares no DSH runtime package as a dependency.
- `pnpm check:patch` runs the generator in check mode. The committed
  `cordis.patch.yml` must be byte-identical to what the installed
  `@deepseek-ai/dsh-web-app@0.2.2-rc.1` produces.
- `test/patch.test.ts` states the installed contract independently of the
  generator: four disabled shipped rows, one declaration with
  `config.id: standard`, the Creator tool rows, the loader expressions, the
  skill-directory expression, and no published name.
- `pnpm check:profile` packs the tarball and installs it into a fresh DSH
  `0.2.2-rc.1` web profile. It asserts no second DSH runtime copy, one
  Standard roster row with built-in display copy, a new session's exact
  model-facing tools and skill catalog, a pre-install Standard session
  resuming, a started session in each removed mode failing and then resuming
  after removal, Arbor beside Standard, and the uninstall path.
- CI runs `pnpm check` and `pnpm check:profile` as two jobs.

## Upgrading

An upgrade is a port, not a version bump:

1. Change `@deepseek-ai/dsh-web-app` in `devDependencies` and the root
   `engines.dsh` to the new exact version.
2. Change `PIN` in `scripts/generate-patch.mjs`, `scripts/check-dsh-pin.mjs`,
   `scripts/check-profile.mjs` and `test/patch.test.ts`, and the package's
   `engines.dsh`.
3. Run `pnpm install --frozen-lockfile` (or update the lockfile with the new
   version), then `pnpm generate`. Read the patch diff: new rows, removed rows
   and changed expressions are the reasons the upgrade exists.
4. Run `pnpm check` and `pnpm check:profile`. If the profile check fails, do not
   merge the upgrade.
5. Set a new `YYYY.MMDD.REVISION` version in Hong Kong time and publish from
   the release branch. The package is a single bundle, so one version.
