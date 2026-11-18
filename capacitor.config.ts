import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cuong007.viewchart',
  appName: 'OpenCharts',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
