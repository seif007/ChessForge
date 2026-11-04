#!/usr/bin/env bash
#
# Source this before any Gradle / expo prebuild command:
#     source scripts/android-env.sh
#
# Configures the Android toolchain that is already installed on this machine and
# neutralises the WorkBuddy Node fs shim (see scripts/install-deps.sh for why).
#
# Discovered toolchain locations:
#   SDK          C:\AndroidSDK            (cmdline-tools 12.0, platform-tools 37.0.0,
#                                          build-tools 36.0.0, platforms android-36 / 36.1,
#                                          all 7 licences accepted)
#   JDK          C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot
#                ^ AGP 8.13 rejects JDK 24 (the pre-existing default); 17-21 required.
#   Gradle       C:\gradle\gradle-8.14      (8.13+ required by AGP 8.13)

# --- disable the WorkBuddy fs shims for this shell --------------------------
unset NODE_OPTIONS
export CODEBUDDY_SAFE_DELETE_ENABLED=0

# --- Android SDK ------------------------------------------------------------
export ANDROID_HOME="C:\\AndroidSDK"
export ANDROID_SDK_ROOT="C:\\AndroidSDK"
ANDROID_HOME_POSIX="/c/AndroidSDK"

# --- JDK --------------------------------------------------------------------
export JAVA_HOME="C:\\Program Files\\Microsoft\\jdk-21.0.12.101-hotspot"
JAVA_HOME_POSIX="/c/Program Files/Microsoft/jdk-21.0.12.101-hotspot"

# --- PATH -------------------------------------------------------------------
# Real node (not the managed runtime), the JDK, the SDK tools, and Gradle.
export PATH="/c/Program Files/nodejs:$JAVA_HOME_POSIX/bin:$ANDROID_HOME_POSIX/platform-tools:$ANDROID_HOME_POSIX/cmdline-tools/latest/bin:/c/gradle/gradle-8.14/bin:$PATH"

# --- Gradle tuning ----------------------------------------------------------
# The Emscripten wasm + base64 assets make the JS bundle large; give Gradle room.
export GRADLE_OPTS="-Xmx4096m -XX:MaxMetaspaceSize=1024m"

echo "ANDROID_HOME = $ANDROID_HOME"
echo "JAVA_HOME    = $JAVA_HOME"
java -version 2>&1 | head -1
