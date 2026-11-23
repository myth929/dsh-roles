/**
 * Host-plugin entry for the `dsh-roles` bundle.
 *
 * The bundle package itself owns `cordis.patch.yml`; loading that package as a
 * plugin row can be resolved as another bundle inclusion. This subpath gives
 * the patch an unambiguously plugin-shaped entry, mirroring other bundles.
 * @module dsh-roles/plugin
 */

export { apply, Config, inject, name } from './index.js'
