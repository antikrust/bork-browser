// The same derp wallpapers the Start page uses, so onboarding looks like the
// browser it is setting up rather than a plain form.
//
// Vite hands back different module shapes for globbed assets depending on the
// build, so unwrap defensively rather than assuming a string.
const wallpapers = import.meta.glob("../assets/background/*.avif", {
  eager: true,
});

function urlOf(mod: unknown): string | null {
  if (!mod) return null;
  if (typeof mod === "string") return mod;
  if (typeof mod === "object") {
    const record = mod as Record<string, unknown>;
    if (typeof record.default === "string") return record.default;
    if (typeof record.url === "string") return record.url;
  }
  return null;
}

const urls = Object.values(wallpapers)
  .map(urlOf)
  .filter((url): url is string => !!url && /\.avif(\?.*)?$/i.test(url));

/** One wallpaper for the whole run, so it does not change between steps. */
export const onboardingWallpaper: string | null = urls.length
  ? urls[Math.floor(Math.random() * urls.length)]
  : null;
