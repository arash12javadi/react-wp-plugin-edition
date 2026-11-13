/**
 * The WordPress-shaped API of React-WP.
 *
 * A developer who knows WordPress can write a plugin or theme here without learning new names: every
 * function is WordPress's, with `rwp_` in front (`wp_insert_post` -> `rwp_insert_post`), and every
 * hook is WordPress's, with `rwp_` in front (`save_post` -> `rwp_save_post`). The catalogue of what
 * exists, what is adapted and what has no meaning here is docs/wordpress-parity.
 *
 * Import from here, or from src/lib/plugin-api, which re-exports all of it.
 */
export * from './hooks';
export * from './errors';
export * from './formatting';
export * from './i18n';
export * from './runtime';
export * from './options';
export * from './posts';
export * from './comments';
export * from './terms';
export * from './query';
export * from './users';
export * from './admin';
export * from './assets';
export * from './shortcodes';
export * from './http';
export * from './postTypes';
export * from './meta';
export * from './content';
export * from './site';
export * from './attachments';
export * from './navMenus';
export * from './utils';
export * from './cache';
export * from './siteOptions';
export * from './l10n';
export * from './formattingExtras';
export * from './httpExtras';
export * from './metaExtras';
export * from './navMenuAdmin';
export * from './plugins';
export * from './postsExtras';
export * from './commentsExtras';
export * from './usersExtras';
export * from './links';
export * from './termsExtras';
