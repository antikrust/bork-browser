import { Background } from "./components/Background/index.tsx";
import { BackgroundProvider } from "./contexts/BackgroundContext.tsx";
import { ComponentsProvider } from "./contexts/ComponentsContext.tsx";
import { DefaultLayout } from "./components/DefaultLayout.tsx";
import { FirefoxNewTabLayout } from "./components/FirefoxNewTabLayout.tsx";
import "./globals.css";
import { useComponents } from "./contexts/ComponentsContext.tsx";

// No settings gear on the start page: new-tab customization is not a
// daily control and the page stays chrome-free (derp simplification).
function NewTabContent() {
  const { components } = useComponents();

  return (
    <>
      <Background />
      <div className="relative w-full min-h-screen">
        {components.firefoxLayout ? <FirefoxNewTabLayout /> : <DefaultLayout />}
      </div>
    </>
  );
}

export default function App() {
  return (
    <ComponentsProvider>
      <BackgroundProvider>
        <NewTabContent />
      </BackgroundProvider>
    </ComponentsProvider>
  );
}
