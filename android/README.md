# Cymbal Auto Group — Android App

This directory contains the native Android application codebase for **Cymbal Auto Group Vehicle ID & Trade-In Valuation**.

---

## ⚡ Quickest Method: Install via QR Code (Zero Build Required)

Any sales representative with an Android device can install the app instantly without compiling code or connecting via USB:

1. On your desktop browser, open your deployed Cymbal Dealership Portal URL (e.g. `https://<your-service-url>.run.app`).
2. Click the **📱 Install on Phone (QR Code)** button in the top navigation bar.
3. Open the camera app on any Android phone (Samsung, Google Pixel, Motorola, etc.) and scan the QR code.
4. Tap the link to open in Google Chrome.
5. Tap **"Install App"** (or Chrome menu `⋮` ➔ **"Add to Home screen"** / **"Install app"**).
6. The app installs as a native Android WebAPK with its own launcher icon, full-screen UI, and direct access to the rear walkaround video camera and microphone.

---

## 🛠️ Building the Native APK via Android Studio

If your dealership IT team requires a signed `.apk` or `.aab` file for Mobile Device Management (MDM) deployment (e.g., Microsoft Intune, Google Workspace Endpoint Management):

### Prerequisites
- [Android Studio Iguana | 2023.2.1](https://developer.android.com/studio) or newer
- JDK 17
- Android SDK 34 (UpsideDownCake)

### Steps to Build & Run
1. Open **Android Studio**.
2. Select **Open...** and select the `./android` directory in this repository.
3. Update `APP_HOST` in `app/src/main/java/com/cymbal/vehicleid/MainActivity.kt` and `android:host` in `AndroidManifest.xml` to match your deployed backend domain.
4. Allow Gradle to sync dependencies (`androidx.webkit`, `androidx.swiperefreshlayout`, etc.).
5. Connect an Android phone via USB with USB Debugging enabled, or launch an Android Virtual Device (AVD).
6. Click **Run ▶** (or press `Shift + F10`) to install directly on the phone.
7. To generate a standalone debug APK from the terminal:
   ```bash
   cd android
   ./gradlew assembleDebug
   # Output APK will be at: app/build/outputs/apk/debug/app-debug.apk
   ```

---

## 📱 Hardware & Permission Features
- **Camera & Mic Integration**: The native wrapper implements `WebChromeClient.onPermissionRequest` and `onShowFileChooser` allowing sales staff to either capture real-time walkaround video using the device camera or pick pre-recorded videos from the gallery.
- **Audio Dialogue Filtering**: Web audio is passed directly to the trade-in analysis engine, which filters background yard noise and isolates sales comments into clean bullet points.
- **Swipe-to-Refresh**: Native `SwipeRefreshLayout` lets reps pull down to reload active inventory or valuation updates.
