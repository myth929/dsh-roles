/**
 * Explicit plugin-shaped re-export of the `dsh-roles` host plugin entry.
 *
 * Allows consumers to import the Cordis plugin exports (`apply`, `Config`,
 * `inject`, `name`) directly via `dsh-roles/plugin` without loading bundle
 * metadata or auxiliary helpers.
 * @module dsh-roles/plugin
 */

export { apply, Config, inject, name } from './index.js'
