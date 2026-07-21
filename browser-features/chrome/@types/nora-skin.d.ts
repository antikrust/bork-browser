// Type declarations for @nora/skin ?raw imports
// These are Vite-specific imports that resolve at build time
// For Deno type checking, we declare them as strings

declare module "@nora/skin/derp/derp-prefs.js?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/derp/css/engine-chrome.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/derp/css/engine-content.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/derp/css/derp.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/*" {
  const content: string;
  export default content;
}
