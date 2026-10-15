// imported explicitly: inside a Gradle Kotlin script bare `java` is the JavaPluginExtension, so
// `java.util.Base64` resolves to nothing at all.
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing: the workflow signs with a keystore when the four secrets are set (ANDROID_KEYSTORE_B64,
// ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD), and otherwise falls back to the
// debug signing config so the APK still installs. A stable key is what lets a later APK update an
// installed one; with the debug fallback every build is a new signature and updating means reinstalling.
val keystoreB64 = System.getenv("ANDROID_KEYSTORE_B64")
val signingReady = !keystoreB64.isNullOrBlank()

android {
    namespace = "com.strongholdluck.android"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.strongholdluck.android"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "0.1.4"
        ndk { abiFilters += "arm64-v8a" }
    }

    if (signingReady) {
        signingConfigs {
            create("release") {
                val ks = File(System.getProperty("java.io.tmpdir"), "strongholdluck-release.jks")
                ks.writeBytes(Base64.getDecoder().decode(keystoreB64))
                storeFile = ks
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "strongholdluck"
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (signingReady) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    // libnode.so and libc++_shared.so must be unpacked into the app's native library directory, not
    // loaded straight out of the APK: Node opens them by path.
    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    androidResources {
        // The staged game tree is ~90 MB of already-compressed art and models; re-compressing it in the
        // APK only costs build time. (Keep the default for anything small.)
        noCompress += listOf("mp3", "ogg", "m4a", "wav", "webp", "png", "jpg", "skel", "atlas", "woff2")
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    // JNA is what lets us call node::Start out of libnode.so without writing a line of JNI.
    implementation("net.java.dev.jna:jna:5.14.0@aar")
}
