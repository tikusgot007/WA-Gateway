plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.auliapos.wagateway"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "com.auliapos.wagateway"
        minSdk = 26
        // SENGAJA 33, BUKAN 34 -- App ini butuh foreground service yang
        // hidup TERUS-MENERUS (Gateway harus selalu terhubung ke WhatsApp).
        // Mulai targetSdk 34, Android membatasi foreground service tipe
        // "dataSync" maksimal ~6 jam kumulatif per 24 jam lalu dipaksa
        // berhenti oleh sistem -- tidak cocok untuk use case app ini.
        // targetSdk 33 masih mengizinkan compileSdk 34 (API terbaru tetap
        // bisa dipakai saat compile), cuma app TIDAK kena kebijakan baru
        // yang mengunci ke targetSdk>=34. Lihat android/README.md.
        targetSdk = 33
        versionCode = 1
        versionName = "1.0.0"

        ndk {
            // Harus sinkron dengan arsitektur libnode.so yang ditaruh di
            // app/libnode/bin/<abi>/ -- lihat android/README.md.
            // x86 dihapus: rilis nodejs-mobile v18.20.4 tidak menyediakan
            // build untuk arsitektur ini (cuma arm64-v8a/armeabi-v7a/x86_64).
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }

        externalNativeBuild {
            cmake {
                cppFlags += ""
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // libnode.so prebuilt (arch/ABI masing-masing) TIDAK ikut di-commit ke
    // repo ini (ukurannya ratusan MB) -- lihat android/README.md untuk cara
    // mengunduh & menaruhnya di app/libnode/bin/<abi>/libnode.so sebelum build.
    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin/")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.navigation:navigation-compose:2.7.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
