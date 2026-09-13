// Jembatan JNI antara Kotlin (NodeBridge.kt) dan runtime Node.js embedded
// (libnode.so dari proyek nodejs-mobile). Pola ini mengikuti contoh resmi
// "native-gradle-node-folder" dari nodejs-mobile-samples -- lihat
// android/README.md untuk sumber & catatan kompatibilitas versi.
//
// Tanggung jawab file ini HANYA dua hal:
//   1. Redirect stdout/stderr proses Node ke Logcat (supaya log Gateway
//      -- termasuk log pino yang dipakai src/logging/index.js -- kelihatan
//      lewat `adb logcat`, karena app Android tidak attach ke terminal).
//   2. Memanggil node::Start() dengan argumen yang dikirim dari Kotlin
//      (lihat NodeBridge.startNodeWithArguments()).
//
// TIDAK ADA logic bisnis Gateway apa pun di sini -- itu semua tetap di
// JavaScript (src/), persis sama dengan versi desktop.

#include <jni.h>
#include <string>
#include <vector>
#include <thread>
#include <unistd.h>
#include <android/log.h>
#include <node.h>

#define LOG_TAG "WaGatewayNode"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

static int pfd_stdout[2];
static int pfd_stderr[2];

static void* thread_stdout_func(void*) {
    ssize_t rdsz;
    char buf[1024];
    while ((rdsz = read(pfd_stdout[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[rdsz - 1] == '\n') --rdsz;
        buf[rdsz] = 0;
        __android_log_write(ANDROID_LOG_INFO, "NodeJS-stdout", buf);
    }
    return nullptr;
}

static void* thread_stderr_func(void*) {
    ssize_t rdsz;
    char buf[1024];
    while ((rdsz = read(pfd_stderr[0], buf, sizeof(buf) - 1)) > 0) {
        if (buf[rdsz - 1] == '\n') --rdsz;
        buf[rdsz] = 0;
        __android_log_write(ANDROID_LOG_WARN, "NodeJS-stderr", buf);
    }
    return nullptr;
}

// Pipe stdout/stderr proses ke Logcat. WAJIB dipanggil SEBELUM node::Start(),
// karena Node.js (dan pino di dalamnya) menulis log ke stdout/stderr biasa --
// tanpa ini, semua log Gateway hilang begitu saja di Android (tidak ada
// konsol yang menampungnya).
static void start_redirecting_stdout_stderr() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    pipe(pfd_stdout);
    dup2(pfd_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, nullptr, _IOLBF, 0);
    pipe(pfd_stderr);
    dup2(pfd_stderr[1], STDERR_FILENO);

    std::thread(thread_stdout_func, nullptr).detach();
    std::thread(thread_stderr_func, nullptr).detach();
}

extern "C"
JNIEXPORT jint JNICALL
Java_com_auliapos_wagateway_NodeBridge_startNodeWithArguments(
        JNIEnv* env, jobject /* this */, jstring workingDir, jobjectArray argsArray) {
    static bool redirected = false;
    if (!redirected) {
        start_redirecting_stdout_stderr();
        redirected = true;
    }

    // src/config/index.js (dan dotenv) meresolve semua path relatif
    // (./auth, ./data/gateway.sqlite, .env) terhadap process.cwd() --
    // chdir ke folder nodejs-project SEBELUM node::Start() supaya semua
    // path itu jatuh ke storage privat app, sama seperti versi desktop
    // meresolve terhadap folder tempat "npm start" dijalankan.
    const char* workingDirChars = env->GetStringUTFChars(workingDir, nullptr);
    if (chdir(workingDirChars) != 0) {
        LOGI("Peringatan: gagal chdir ke %s", workingDirChars);
    }
    env->ReleaseStringUTFChars(workingDir, workingDirChars);

    int argc = env->GetArrayLength(argsArray);

    // argv[i] harus tetap hidup selama node::Start() berjalan -- simpan
    // salinan std::string-nya dulu (bukan cuma pointer JNI sementara)
    // sebelum diubah jadi array char* mentah yang diminta node::Start().
    std::vector<std::string> ownedArgs;
    ownedArgs.reserve(argc);
    for (int i = 0; i < argc; i++) {
        auto jstr = (jstring) env->GetObjectArrayElement(argsArray, i);
        const char* chars = env->GetStringUTFChars(jstr, nullptr);
        ownedArgs.emplace_back(chars);
        env->ReleaseStringUTFChars(jstr, chars);
        env->DeleteLocalRef(jstr);
    }

    std::vector<char*> argv;
    argv.reserve(ownedArgs.size());
    for (auto& s : ownedArgs) {
        argv.push_back(const_cast<char*>(s.c_str()));
    }

    LOGI("Memulai runtime Node.js embedded (argc=%d)...", argc);
    int ret = node::Start(argc, argv.data());
    LOGI("Runtime Node.js berhenti (exit code %d).", ret);
    return ret;
}
