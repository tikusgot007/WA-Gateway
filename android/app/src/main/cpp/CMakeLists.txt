cmake_minimum_required(VERSION 3.22.1)
project("wagateway_native")

# Prebuilt libnode.so (dari proyek nodejs-mobile) + header Node.js-nya TIDAK
# ikut commit di repo ini (binary-nya ratusan MB per arsitektur). Harus
# diunduh & ditaruh manual sebelum build -- lihat android/README.md:
#   app/libnode/bin/<abi>/libnode.so
#   app/libnode/include/node/*.h
set(NODEJS_MOBILE_LIBNODE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
    ${NODEJS_MOBILE_LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

include_directories(${NODEJS_MOBILE_LIBNODE_DIR}/include/node)

add_library(native-lib SHARED native-lib.cpp)

find_library(log-lib log)

target_link_libraries(native-lib node ${log-lib} android)
