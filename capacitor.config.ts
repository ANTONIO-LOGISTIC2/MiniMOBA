import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.minimoba.app',
  appName: 'MiniMOBA',
  webDir: 'www',
  plugins: {
    // Immersive fullscreen at launch (hides the status bar + gesture-nav
    // bar). Bundled with @capacitor/core - no native code needed. Also
    // fixes correct env(safe-area-inset-*) values on WebView versions
    // that don't report them natively (insetsHandling: 'css' is already
    // the default, kept explicit here for clarity).
    SystemBars: {
      hidden: true,
      style: 'DARK',
      insetsHandling: 'css'
    }
  }
};

export default config;
