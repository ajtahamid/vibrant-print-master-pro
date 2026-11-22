import { packager } from '@electron/packager';
const paths = await packager({
  dir: '.', out: process.env.OUT || 'dist', overwrite: true,
  platform: 'darwin', arch: 'arm64',
  name: 'Vibrant Print Master Pro', executableName: 'Vibrant Print Master Pro',
  appBundleId: 'com.tahamid.vibrantprintmasterpro', appCategoryType: 'public.app-category.graphics-design',
  appVersion: '1.1.0', buildVersion: '1.1.0', appCopyright: 'Created by Tahamid',
  icon: 'build/icon.icns', asar: false, prune: true,
  ignore: [/^\/scratch/, /^\/build/, /^\/dist/, /\.map$/, /^\/node_modules\/electron($|\/)/, /^\/node_modules\/@electron/],
  extendInfo: {
    NSHumanReadableCopyright: 'Created by Tahamid',
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'Vibrant Print Master Pro Document', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Owner', CFBundleTypeExtensions: ['vpm'], CFBundleTypeIconFile: 'electron.icns' }],
    LSMinimumSystemVersion: '12.0',
  },
});
console.log(paths);
