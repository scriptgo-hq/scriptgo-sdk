# libscriptgo: the SCRIPT//GO escrow loader as a C-ABI shared library.
#
#   Windows (MSVC, x64): use build.ps1, which fetches the pinned libsodium package and drives this.
#   Linux / macOS:       cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
#                        (needs libsodium >= 1.0.19 with its static archive, and pkg-config).
#                        NOT BUILT OR TESTED where this file was written: see README.md.
#
# libsodium is linked statically on purpose: a libsodium.dll / libsodium.so dropped next to the host
# must not be able to stand between this library and its keys.
cmake_minimum_required(VERSION 3.21)
project(scriptgo VERSION 0.1.0 LANGUAGES C)
if(WIN32)
  enable_language(RC)
endif()

option(SG_BUILD_TESTS "Build the CTest suite" ON)
set(SG_SODIUM_ROOT "" CACHE PATH "Windows: the extracted libsodium MSVC package (holds include/ and x64/)")
set(SG_TEST_LUA_LIBRARY "" CACHE FILEPATH "A Lua 5.4 shared library (lua54.dll / liblua54.so) for the Lua load test")
option(SG_ALLOW_SHARED_SODIUM "Linux/macOS: link libsodium dynamically when no static archive exists (weaker)" OFF)
option(SG_SANITIZE "Build the library and its tests with AddressSanitizer. A test configuration: never ship its output" OFF)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
# A static C runtime on Windows: the DLL then needs no Visual C++ redistributable, and it matches
# the runtime the prebuilt static libsodium was compiled against.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")

# ------------------------------------------------------------------------------------------ libsodium
add_library(sg_sodium INTERFACE)
if(MSVC)
  if(NOT SG_SODIUM_ROOT OR NOT EXISTS "${SG_SODIUM_ROOT}/include/sodium.h")
    message(FATAL_ERROR "SG_SODIUM_ROOT must point at the extracted libsodium MSVC package (run build.ps1, which fetches and checks it).")
  endif()
  if(CMAKE_SIZEOF_VOID_P EQUAL 8 AND NOT CMAKE_GENERATOR_PLATFORM MATCHES "ARM64")
    set(SG_SODIUM_ARCH "x64")
  elseif(CMAKE_GENERATOR_PLATFORM MATCHES "ARM64")
    set(SG_SODIUM_ARCH "ARM64")
  else()
    set(SG_SODIUM_ARCH "Win32")
  endif()
  set(SG_SODIUM_LIB_RELEASE "${SG_SODIUM_ROOT}/${SG_SODIUM_ARCH}/Release/v143/static/libsodium.lib")
  set(SG_SODIUM_LIB_DEBUG "${SG_SODIUM_ROOT}/${SG_SODIUM_ARCH}/Debug/v143/static/libsodium.lib")
  if(NOT EXISTS "${SG_SODIUM_LIB_RELEASE}")
    message(FATAL_ERROR "No static libsodium for ${SG_SODIUM_ARCH} at ${SG_SODIUM_LIB_RELEASE}")
  endif()
  if(NOT EXISTS "${SG_SODIUM_LIB_DEBUG}")
    set(SG_SODIUM_LIB_DEBUG "${SG_SODIUM_LIB_RELEASE}")
  endif()
  target_include_directories(sg_sodium SYSTEM INTERFACE "${SG_SODIUM_ROOT}/include")
  target_compile_definitions(sg_sodium INTERFACE SODIUM_STATIC)
  target_link_libraries(sg_sodium INTERFACE "$<IF:$<CONFIG:Debug>,${SG_SODIUM_LIB_DEBUG},${SG_SODIUM_LIB_RELEASE}>" advapi32)
else()
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(SODIUM REQUIRED libsodium>=1.0.19)
  # Prefer the static archive. pkg-config only says where the library directory is.
  find_library(SG_SODIUM_ARCHIVE NAMES libsodium.a HINTS ${SODIUM_LIBRARY_DIRS} ${SODIUM_STATIC_LIBRARY_DIRS} NO_CACHE)
  target_include_directories(sg_sodium SYSTEM INTERFACE ${SODIUM_INCLUDE_DIRS})
  if(SG_SODIUM_ARCHIVE)
    message(STATUS "libsodium: static archive ${SG_SODIUM_ARCHIVE}")
    target_compile_definitions(sg_sodium INTERFACE SODIUM_STATIC)
    target_link_libraries(sg_sodium INTERFACE "${SG_SODIUM_ARCHIVE}")
    find_package(Threads)
    if(Threads_FOUND)
      target_link_libraries(sg_sodium INTERFACE Threads::Threads)
    endif()
  elseif(SG_ALLOW_SHARED_SODIUM)
    message(WARNING "libsodium: no static archive found, linking the shared library. A replaced libsodium can then observe keys.")
    target_link_directories(sg_sodium INTERFACE ${SODIUM_LIBRARY_DIRS})
    target_link_libraries(sg_sodium INTERFACE ${SODIUM_LIBRARIES})
  else()
    message(FATAL_ERROR "libsodium.a was not found (install the static archive, or pass -DSG_ALLOW_SHARED_SODIUM=ON to accept the weaker dynamic link).")
  endif()
endif()

# ---------------------------------------------------------------------------------------------- miniz
# Vendored inflater (MIT). Only tinfl and mz_crc32 are compiled in: no archive API, no deflate, no
# stdio, no heap. Built as its own object library so our warning level does not apply to it.
add_library(sg_miniz OBJECT third_party/miniz/miniz.c)
target_include_directories(sg_miniz PUBLIC third_party/miniz)
target_compile_definitions(sg_miniz PUBLIC
  MINIZ_NO_STDIO MINIZ_NO_TIME MINIZ_NO_ARCHIVE_APIS
  MINIZ_NO_DEFLATE_APIS MINIZ_NO_ZLIB_APIS MINIZ_NO_ZLIB_COMPATIBLE_NAMES MINIZ_NO_MALLOC)
if(MSVC)
  target_compile_options(sg_miniz PRIVATE /W0 /guard:cf /GS /Brepro)
else()
  target_compile_options(sg_miniz PRIVATE -w -fstack-protector-strong)
endif()

# AddressSanitizer, for running the test suite against the parser and the accessors. libsodium is
# not instrumented (it is a prebuilt archive), and its guarded allocations are outside ASan's view.
set(SG_SANITIZE_COMPILE "")
set(SG_SANITIZE_LINK "")
if(SG_SANITIZE)
  if(MSVC)
    set(SG_SANITIZE_COMPILE /fsanitize=address /Zi)
    set(SG_SANITIZE_LINK /DEBUG /INCREMENTAL:NO)
  else()
    set(SG_SANITIZE_COMPILE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
    set(SG_SANITIZE_LINK -fsanitize=address,undefined)
  endif()
  target_compile_options(sg_miniz PRIVATE ${SG_SANITIZE_COMPILE})
  message(WARNING "SG_SANITIZE is ON: this build is for testing only and must not be shipped.")
endif()

# ------------------------------------------------------------------------------------------- scriptgo
set(SG_SOURCES src/escrow.c src/asset.c src/zip.c src/identity_win.c src/identity_posix.c)
if(WIN32)
  list(APPEND SG_SOURCES src/scriptgo.rc)
endif()
add_library(scriptgo SHARED ${SG_SOURCES} $<TARGET_OBJECTS:sg_miniz>)
target_include_directories(scriptgo PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:include>)
target_include_directories(scriptgo PRIVATE src third_party/miniz)
target_compile_definitions(scriptgo PRIVATE SG_BUILD_SHARED $<TARGET_PROPERTY:sg_miniz,INTERFACE_COMPILE_DEFINITIONS>)
target_link_libraries(scriptgo PRIVATE sg_sodium)
set_target_properties(scriptgo PROPERTIES OUTPUT_NAME scriptgo)

if(MSVC)
  # /sdl: extra security checks; /guard:cf: control-flow guard; /GS: stack cookies; /Brepro: no
  # timestamps in the objects or the PE header, so the same sources and toolchain give the same DLL.
  target_compile_options(scriptgo PRIVATE /W4 /WX /sdl /guard:cf /GS /utf-8 /Brepro)
  target_compile_definitions(scriptgo PRIVATE UNICODE _UNICODE)
  # No debug information is produced or shipped (/DEBUG:NONE). The only exports are the sg_* ABI:
  # they are the functions marked SG_API, and the C runtime and libsodium are linked statically.
  target_link_options(scriptgo PRIVATE /guard:cf /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA)
  if(SG_SANITIZE)
    target_compile_options(scriptgo PRIVATE ${SG_SANITIZE_COMPILE})
    target_link_options(scriptgo PRIVATE ${SG_SANITIZE_LINK})
  else()
    target_link_options(scriptgo PRIVATE /DEBUG:NONE /OPT:REF /OPT:ICF /Brepro /WX)
  endif()
  if(CMAKE_SIZEOF_VOID_P EQUAL 8 AND NOT CMAKE_GENERATOR_PLATFORM MATCHES "ARM64")
    target_link_options(scriptgo PRIVATE /CETCOMPAT)
  endif()
  target_link_libraries(scriptgo PRIVATE crypt32)
else()
  target_compile_options(scriptgo PRIVATE -Wall -Wextra -Wpedantic -Werror -fstack-protector-strong)
  target_compile_definitions(scriptgo PRIVATE _POSIX_C_SOURCE=200809L)
  if(SG_SANITIZE)
    target_compile_options(scriptgo PRIVATE ${SG_SANITIZE_COMPILE})
    target_link_options(scriptgo PRIVATE ${SG_SANITIZE_LINK})
  else()
    target_compile_definitions(scriptgo PRIVATE $<$<NOT:$<CONFIG:Debug>>:_FORTIFY_SOURCE=2>)
  endif()
  if(APPLE)
    # Hidden visibility covers our own code; the static libsodium must not be re-exported either.
    target_link_options(scriptgo PRIVATE -Wl,-exported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/src/exports.macos.txt -Wl,-dead_strip)
  else()
    target_link_options(scriptgo PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map
      -Wl,--exclude-libs,ALL -Wl,-z,relro -Wl,-z,now -Wl,-z,noexecstack -Wl,--gc-sections)
    set_target_properties(scriptgo PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/exports.map)
  endif()
endif()

include(GNUInstallDirs)
install(TARGETS scriptgo
  RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
  LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
  ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(DIRECTORY include/scriptgo DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

# ---------------------------------------------------------------------------------------------- tests
if(SG_BUILD_TESTS)
  enable_testing()
  add_executable(sg_tests tests/test_escrow.c)
  target_link_libraries(sg_tests PRIVATE scriptgo)
  if(SG_SANITIZE)
    target_compile_options(sg_tests PRIVATE ${SG_SANITIZE_COMPILE})
    target_link_options(sg_tests PRIVATE ${SG_SANITIZE_LINK})
  endif()
  if(MSVC)
    target_compile_options(sg_tests PRIVATE /W4 /WX /utf-8)
    target_compile_definitions(sg_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
  else()
    target_compile_options(sg_tests PRIVATE -Wall -Wextra)
    target_compile_definitions(sg_tests PRIVATE _POSIX_C_SOURCE=200809L)
    target_link_libraries(sg_tests PRIVATE ${CMAKE_DL_LIBS})
  endif()
  # One CTest entry per case, so a failure names what broke. Keep in step with tests/test_escrow.c.
  set(SG_TEST_CASES
    abi_and_errors
    sha256_known_answer
    identity_generate_and_import
    identity_persistence_round_trip
    identity_refuses_damaged_file
    verify_manifest_good
    verify_manifest_bad_signature
    archive_reads_outer_bundle
    archive_survives_mutations
    open_good_path
    open_refuses_tampered_payload
    open_refuses_wrong_payload_hash
    open_refuses_wrong_identity
    open_refuses_wrong_aad
    open_refuses_corrupt_inner_zip
    open_refuses_path_traversal
    copy_door_and_marker
    lua_load_through_real_lua
    handles_reject_misuse)
  foreach(case IN LISTS SG_TEST_CASES)
    add_test(NAME ${case} COMMAND sg_tests ${case})
    set_tests_properties(${case} PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 60)
  endforeach()
  if(SG_TEST_LUA_LIBRARY)
    set_tests_properties(lua_load_through_real_lua PROPERTIES ENVIRONMENT "SG_TEST_LUA_LIBRARY=${SG_TEST_LUA_LIBRARY}")
  endif()

  # Asset escrow (docs/spec/assets.md), against tests/asset_vector.h. Keep in step with tests/test_asset.c.
  add_executable(sg_asset_tests tests/test_asset.c)
  target_link_libraries(sg_asset_tests PRIVATE scriptgo)
  if(SG_SANITIZE)
    target_compile_options(sg_asset_tests PRIVATE ${SG_SANITIZE_COMPILE})
    target_link_options(sg_asset_tests PRIVATE ${SG_SANITIZE_LINK})
  endif()
  if(MSVC)
    target_compile_options(sg_asset_tests PRIVATE /W4 /WX /utf-8)
    target_compile_definitions(sg_asset_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
  else()
    target_compile_options(sg_asset_tests PRIVATE -Wall -Wextra)
  endif()
  set(SG_ASSET_TEST_CASES
    asset_keys_unwrap_and_rewrap
    asset_client_vector_unwrap
    asset_container_good_path
    asset_container_refuses_other_key
    asset_container_refuses_tampering
    asset_reader_refuses_changed_chunk
    asset_escrowed_preload_vector
    asset_container_survives_mutations
    asset_handles_reject_misuse)
  foreach(case IN LISTS SG_ASSET_TEST_CASES)
    add_test(NAME ${case} COMMAND sg_asset_tests ${case})
    set_tests_properties(${case} PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120)
  endforeach()

  # Client code escrow (docs/spec/client-escrow.md), against tests/client_vector.h. Keep in step with tests/test_clink.c.
  add_executable(sg_clink_tests tests/test_clink.c)
  target_link_libraries(sg_clink_tests PRIVATE scriptgo)
  if(SG_SANITIZE)
    target_compile_options(sg_clink_tests PRIVATE ${SG_SANITIZE_COMPILE})
    target_link_options(sg_clink_tests PRIVATE ${SG_SANITIZE_LINK})
  endif()
  if(MSVC)
    target_compile_options(sg_clink_tests PRIVATE /W4 /WX /utf-8)
    target_compile_definitions(sg_clink_tests PRIVATE _CRT_SECURE_NO_WARNINGS)
  else()
    target_compile_options(sg_clink_tests PRIVATE -Wall -Wextra)
    target_link_libraries(sg_clink_tests PRIVATE ${CMAKE_DL_LIBS})
  endif()
  set(SG_CLINK_TEST_CASES
    clink_keys_unwrap_and_rewrap
    clink_container_good_path
    clink_refuses_other_keys
    clink_refuses_tampering
    clink_refuses_other_targets
    clink_container_survives_mutations
    clink_lua_load_through_real_lua
    clink_handles_reject_misuse)
  foreach(case IN LISTS SG_CLINK_TEST_CASES)
    add_test(NAME ${case} COMMAND sg_clink_tests ${case})
    set_tests_properties(${case} PROPERTIES SKIP_RETURN_CODE 77 TIMEOUT 120)
  endforeach()
  if(SG_TEST_LUA_LIBRARY)
    set_tests_properties(clink_lua_load_through_real_lua PROPERTIES ENVIRONMENT "SG_TEST_LUA_LIBRARY=${SG_TEST_LUA_LIBRARY}")
  endif()
endif()
