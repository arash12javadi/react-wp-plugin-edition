declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.css?inline' {
  const content: string;
  export default content;
}

// The Vercel functions under `api/` re-export `src/server-dist/vercel.mjs`, the single-file bundle
// `npm run build:api` writes. That path is git-ignored, so on a fresh checkout — before a build has
// run — the file is not there and a project-wide type check would report `Cannot find module` for
// those imports. Declared without a body (that is, `any`): the bundle is generated JavaScript that
// is re-exported verbatim, and nothing here could type its contents better than that.
declare module '*/server-dist/vercel.mjs';