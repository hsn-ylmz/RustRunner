/**
 * After Pack Script
 *
 * Copies native binaries (rustrunner, micromamba) and icon assets
 * into the packaged application during the electron-builder build process.
 */

const path = require('path');
const fs = require('fs');

/**
 * Copies a binary file to the resources directory with executable permissions.
 */
function copyBinary(srcPath, destPath, name, isWindows = false) {
  if (!fs.existsSync(srcPath)) {
    console.warn(`[WARN] ${name} not found at: ${srcPath}`);
    return false;
  }

  try {
    fs.copyFileSync(srcPath, destPath);
    
    // Set executable permissions on Unix systems only
    if (!isWindows) {
      fs.chmodSync(destPath, 0o755);
    }
    
    // Log file size for verification
    const stats = fs.statSync(destPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`[OK] ${name} copied to: ${destPath} (${sizeMB} MB)`);
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to copy ${name}: ${error.message}`);
    return false;
  }
}

exports.default = async function (context) {
  console.log('\n=== Running afterPack script ===\n');

  const { appOutDir, electronPlatformName } = context;
  const isWindows = electronPlatformName === 'win32';
  const isMac = electronPlatformName === 'darwin';

  // Determine resources directory based on platform
  let resourcesDir;
  if (isMac) {
    resourcesDir = path.join(appOutDir, 'RustRunner.app/Contents/Resources');
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
  }

  console.log(`Platform: ${electronPlatformName}`);
  console.log(`Resources: ${resourcesDir}`);

  // Ensure resources directory exists
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  // Determine binary names based on platform
  const rustBinaryName = isWindows ? 'rustrunner.exe' : 'rustrunner';
  const micromambaBinaryName = isWindows ? 'micromamba.exe' : 'micromamba';

  // Copy Rust executable
  const rustSrcPath = path.join(
    __dirname,
    '../../RustRunner/target/release',
    rustBinaryName
  );
  const rustDestPath = path.join(resourcesDir, rustBinaryName);

  if (!copyBinary(rustSrcPath, rustDestPath, 'Rust executable', isWindows)) {
    console.error('\n[ERROR] Build the Rust backend first:');
    console.error('  cd ../RustRunner && cargo build --release\n');
    throw new Error('Rust executable not found');
  }

  // Copy micromamba (optional)
  const micromambaSrcPath = path.join(
    __dirname,
    '../../RustRunner/runtime',
    micromambaBinaryName
  );
  const micromambaDestPath = path.join(resourcesDir, micromambaBinaryName);

  if (!copyBinary(micromambaSrcPath, micromambaDestPath, 'Micromamba', isWindows)) {
    console.warn('[WARN] Workflows requiring conda environments will not work.');
    console.warn('  Download from: https://micro.mamba.pm/\n');
  }

  // Copy env_map.json (tool→environment mappings)
  const envMapSrcPath = path.join(
    __dirname,
    '../../RustRunner/runtime/env_map.json'
  );
  const envMapDestPath = path.join(resourcesDir, 'env_map.json');

  if (fs.existsSync(envMapSrcPath)) {
    fs.copyFileSync(envMapSrcPath, envMapDestPath);
    console.log(`[OK] env_map.json copied to: ${envMapDestPath}`);
  } else {
    // Create empty env_map if none exists
    const emptyMap = { map: {} };
    fs.writeFileSync(envMapDestPath, JSON.stringify(emptyMap, null, 2));
    console.log(`[OK] Created empty env_map.json at: ${envMapDestPath}`);
  }

  // Copy icon assets for dynamic light/dark mode switching
  const assetsDir = path.join(__dirname, '../assets');
  const destAssetsDir = path.join(resourcesDir, 'assets');

  if (!fs.existsSync(destAssetsDir)) {
    fs.mkdirSync(destAssetsDir, { recursive: true });
  }

  const iconFiles = [
    'icon_light.png',
    'icon_dark.png',
    'icon_light.icns',
    'icon_dark.icns',
    'icon_light.ico',
    'icon_dark.ico',
  ];

  console.log('\nCopying icon assets...');
  for (const iconFile of iconFiles) {
    const srcIcon = path.join(assetsDir, iconFile);
    const destIcon = path.join(destAssetsDir, iconFile);
    if (fs.existsSync(srcIcon)) {
      fs.copyFileSync(srcIcon, destIcon);
      console.log(`[OK] ${iconFile} copied to: ${destIcon}`);
    } else {
      console.warn(`[WARN] ${iconFile} not found at: ${srcIcon}`);
    }
  }

  console.log('\n=== afterPack completed ===\n');
};