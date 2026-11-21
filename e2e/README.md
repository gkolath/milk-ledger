# UI automation

Drives the real Android app on an emulator with [Appium](https://appium.io/), the same way a
person would: tapping buttons, typing into fields, reading what's on screen. No chromedriver is
used — the WebView's own content is read through Android's accessibility tree (UiAutomator2),
since matching a chromedriver build to the emulator's WebView version isn't always possible, and
this way the tests don't depend on it. Text fields are typed into via `adb shell input text`
rather than Appium's `setValue()`, because `setValue()` only updates the accessibility layer's
own copy, not the real page the app reads from.

## One-time setup

- Android SDK with an AVD (Android Studio's own setup covers this) and a `local.properties`
  pointing `sdk.dir` at it — both already exist for this project.
- `npm install -g appium && appium driver install uiautomator2`
- `npm install` in this folder

## Running

```bash
export ANDROID_HOME=~/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# 1. Boot an emulator if one isn't already running (skip if `adb devices` shows one)
emulator -avd $(emulator -list-avds | head -1) -no-window -no-audio -no-boot-anim &

# 2. Start the Appium server if one isn't already running (skip if already up)
appium --base-path /wd/hub &

# 3. Build and install the app under test
cd ../app && npx cap sync android && cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 4. Run the tests
cd ../../e2e && npm test
```

Each run clears the app's data first (`adb shell pm clear`), so every test starts from a fresh
install with no ledger history — this is what lets the day-marking tests assume day 1 starts
unmarked.

## What it covers

`tests/app.test.mjs`: the sign-in screen, saving seller details in Settings, marking/unmarking/
clearing a day on the calendar and the bill total updating accordingly, and that the 1-litre and
½-litre tabs track their days independently.
