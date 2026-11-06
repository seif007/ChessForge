set -uo pipefail
export JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
export ANDROID_HOME='C:\AndroidSDK'
export ANDROID_SDK_ROOT='C:\AndroidSDK'
export GRADLE_USER_HOME='C:\gradle-home-chessforge'
export CODEBUDDY_SAFE_DELETE_ENABLED=0
export PATH="/c/Program Files/Microsoft/jdk-21.0.12.101-hotspot/bin:/c/AndroidSDK/platform-tools:/c/Program Files/nodejs:/usr/bin:/bin:/mingw64/bin:/c/Windows/system32:/c/Windows"
unset NODE_OPTIONS
unset REACT_NATIVE_NODE_ARGS

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/android" || exit 1

STAMP=$(date +%Y%m%d-%H%M%S)
# The stale-bundle trap: src/** is not a declared input of the bundle task.
for d in "$ROOT/android/app/build/generated/assets/react/release" "$HOME/AppData/Local/Temp/metro-cache"; do
  if [ -e "$d" ]; then mv "$d" "$d.stale-$STAMP" && echo "moved aside: $d"; fi
done

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
rm -f "$APK"

echo "=== building (started $(date)) ==="
# llama.rn 0.13.0-rc.7 ships with rnllamaBuildFromSource=true, so it compiles the
# native library from the vendored llama.cpp. By default that is SEVEN full copies
# of the tree (one per CPU-feature variant), including an OpenCL/Hexagon variant
# whose generated object paths pass Windows' MAX_PATH — ninja then fails with a
# bare "No such file or directory". The coach is CPU-only, so build the generic
# variant only: ggml still dispatches CPU features at runtime, and RNLlama.java
# falls back to rnllama_jni when the specialised wrappers are absent.
NODE_ENV=production NO_COLOR=1 TERM=dumb \
  ./gradlew :app:assembleRelease --no-daemon --console=plain \
  -PrnllamaVariants=rnllama 2>&1 | tail -n 60
STATUS=${PIPESTATUS[0]}
echo "=== gradle exit $STATUS at $(date) ==="
ls -lh "$APK" 2>/dev/null || echo "NO APK"
exit $STATUS
