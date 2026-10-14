// Root build file. The plugin versions are the ones the cloud build was written against; the runner
// supplies the Android SDK, so nothing here downloads one.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
