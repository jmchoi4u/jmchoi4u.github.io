# jm-studio lane 3 donor handoff

Date: 2026-04-15
Owner: worker-3
Scope: `app/public/index.html`, `app/public/app.js`

## What was harvested

### Stable donor surfaces
- `app/public/index.html` now marks the lane-3 donor sections with `data-integration-surface`:
  - `posts-manager`
  - `template-manager`
  - `deploy`
- Interactive controls inside those sections now carry stable `data-integration-action` markers so a later `jm-studio` merge can lift behavior without re-deriving brittle selectors from presentation-only classes.

### Reusable donor contract
- `app/public/app.js` now publishes `window.__JM_STUDIO_DONOR__`.
- Contract contents:
  - `version`
  - `exportedAt`
  - `apiRoutes` for posts/templates/deploy endpoints
  - `selectors` mapped to the new `data-integration-*` hooks
  - `snapshot()` for live regression-state capture
  - `helpers` exposing reusable lane-3 logic:
    - `sortPosts`
    - `groupPostsByLaneState`
    - `renderTemplates`
    - `renderPosts`

## Intended merge use

### Posts manager
- Reuse `groupPostsByLaneState()` to keep published / pending / drafts / hidden grouping behavior aligned.
- Use `selectors.surfaces.postsManager` plus `selectors.actions.posts*` as the merge map for refresh/search/filter/sort/tab/list bindings.

### Template manager
- Use `selectors.surfaces.templateManager` and `selectors.actions.template*`.
- `snapshot().templates` gives a quick sanity read on selected template, current filename, editor body length, and preview readiness.

### Deploy integration
- Use `selectors.surfaces.deploy` and `selectors.actions.deploy*`.
- `apiRoutes` documents the lane-3 local-power endpoints already exercised by the donor app.

## Validation notes

### Successful read-only endpoint smoke checks
- `GET /api/summary`
- `GET /api/posts`
- `GET /api/templates`
- `GET /api/preview-status`

Observed at validation time:
- posts count: `6`
- templates count: `5`
- preview running: `false`

### Build-path result
- `POST /api/build` currently fails in this environment with:
  - `/mnt/c/Ruby34-x64/bin/bundle: 10: exec: ruby: not found`

This is an environment/toolchain issue, not a lane-3 JavaScript contract issue.

### Explicitly not executed
- `POST /api/publish`
  - skipped because it would create/push real repo changes

## Merge caution

- The donor contract is intentionally additive and non-invasive.
- Future merge work should preserve the `data-integration-*` hooks until the `jm-studio` shell fully absorbs lane-3 behaviors and regression coverage is re-established there.
