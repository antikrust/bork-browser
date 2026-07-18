import { MemoryRouter, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import ProgressBar from "./components/ProgressBar.tsx";
import { rpc } from "./lib/rpc/rpc.ts";
import WhatsNewPage from "./app/whatsnew/page.tsx";
import { I18nProvider } from "./components/I18nProvider.tsx";
import { onboardingWallpaper } from "./lib/backgroundImage.ts";

const WelcomePage = lazy(() => import("./app/welcome/page.tsx"));
const LocalizationPage = lazy(() => import("./app/localization/page.tsx"));
const ImportPage = lazy(() => import("./app/import/page.tsx"));
const HubIntroPage = lazy(() => import("./app/hub/page.tsx"));
const FeaturesPage = lazy(() => import("./app/features/page.tsx"));
const CustomizePage = lazy(() => import("./app/customize/page.tsx"));
const FinishPage = lazy(() => import("./app/finish/page.tsx"));

function App() {
  //* Set welcome page shown to true (kept for first-run compatibility)
  rpc.setBoolPref("floorp.browser.welcome.page.shown", true);

  // Detect upgrade query (e.g., about:welcome?upgrade=12)
  const url = new URL(globalThis.location.href);
  const upgrade = url.searchParams.get("upgrade");

  // If upgrade mode, show only the WhatsNew page, similar to Chrome's post-update UI
  if (upgrade) {
    return (
      <I18nProvider>
        <div className="min-h-screen bg-base-100 text-base-content flex flex-col">
          <WhatsNewPage />
        </div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <MemoryRouter>
        {/* The wallpaper sits behind everything as a fixed layer with a scrim
            over it, so the steps stay readable whichever image comes up and the
            picture does not scroll away under the content. No overflow-hidden
            on the wrapper: it clips the page flow whenever the height is
            constrained, which leaves the steps unscrollable. */}
        <div className="min-h-screen text-base-content flex flex-col relative">
          <div
            className="fixed inset-0 -z-10 bg-base-100 bg-cover bg-center"
            style={onboardingWallpaper
              ? { backgroundImage: `url("${onboardingWallpaper}")` }
              : undefined}
            aria-hidden="true"
          />
          <div className="fixed inset-0 -z-10 bg-base-100/80" aria-hidden="true" />

          <header className="container mx-auto px-4 pt-8 relative z-10">
            <ProgressBar />
          </header>
          <main className="flex-1 container mx-auto max-w-6xl px-4 py-4 md:px-8 lg:px-12 xl:px-0 relative z-10">
            <Suspense
              fallback={
                <div className="loading loading-spinner loading-lg"></div>
              }
            >
              <Routes>
                <Route path="/" element={<WelcomePage />} />
                <Route path="/localization" element={<LocalizationPage />} />
                <Route path="/import" element={<ImportPage />} />
                <Route path="/features" element={<FeaturesPage />} />
                <Route path="/hub" element={<HubIntroPage />} />
                <Route path="/customize" element={<CustomizePage />} />
                <Route path="/finish" element={<FinishPage />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </MemoryRouter>
    </I18nProvider>
  );
}

export default App;
