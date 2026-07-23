// Type declarations for @nora/skin ?raw imports
// These are Vite-specific imports that resolve at build time
// For Deno type checking, we declare them as strings

declare module "@nora/skin/bork/bork-prefs.js?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/bork/css/engine-chrome.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/bork/css/engine-content.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/bork/css/bork.css?raw" {
  const content: string;
  export default content;
}

declare module "@nora/skin/*" {
  const content: string;
  export default content;
}
