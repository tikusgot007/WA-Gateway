# WA Gateway - aturan ProGuard/R8 tambahan.
# Node.js jalan sebagai proses embedded via JNI (lihat native-lib.cpp) --
# tidak ada kode Java/Kotlin reflektif dari sisi Node yang perlu dijaga,
# jadi tidak ada aturan khusus tambahan untuk ini.
