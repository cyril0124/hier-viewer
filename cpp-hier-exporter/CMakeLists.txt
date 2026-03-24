cmake_minimum_required(VERSION 3.20)

if(POLICY CMP0091)
  cmake_policy(SET CMP0091 NEW)
endif()

project(slang_hier_exporter LANGUAGES CXX)

option(HIER_VIEWER_EXPORTER_FULLY_STATIC
       "Prefer a maximally static exporter binary where the platform allows it"
       ON)
set(HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR
    ""
    CACHE PATH "Path to a local slang checkout to use instead of FetchContent")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(SLANG_INCLUDE_TOOLS OFF CACHE BOOL "" FORCE)
set(SLANG_INCLUDE_TESTS OFF CACHE BOOL "" FORCE)
set(SLANG_INCLUDE_DOCS OFF CACHE BOOL "" FORCE)
set(SLANG_INCLUDE_INSTALL OFF CACHE BOOL "" FORCE)
set(SLANG_INCLUDE_PYLIB OFF CACHE BOOL "" FORCE)
set(SLANG_USE_MIMALLOC OFF CACHE BOOL "" FORCE)
set(SLANG_USE_CPPTRACE OFF CACHE BOOL "" FORCE)

if(MSVC AND HIER_VIEWER_EXPORTER_FULLY_STATIC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(HIER_VIEWER_EXPORTER_FIND_STATIC_DEPS OFF)
if(CMAKE_SYSTEM_NAME MATCHES "Linux" AND HIER_VIEWER_EXPORTER_FULLY_STATIC)
  set(HIER_VIEWER_EXPORTER_FIND_STATIC_DEPS ON)
endif()

if(APPLE AND HIER_VIEWER_EXPORTER_FULLY_STATIC)
  message(
    STATUS
      "macOS does not support fully static executables; keeping slang static while using the platform dynamic linker for system libraries"
  )
endif()

if(HIER_VIEWER_EXPORTER_FIND_STATIC_DEPS)
  set(_HIER_VIEWER_EXPORTER_ORIG_FIND_LIBRARY_SUFFIXES ${CMAKE_FIND_LIBRARY_SUFFIXES})
  set(_HIER_VIEWER_EXPORTER_ORIG_FIND_LIBRARY_PREFER_STATIC ${CMAKE_FIND_LIBRARY_PREFER_STATIC})
  set(CMAKE_FIND_LIBRARY_SUFFIXES .a)
  set(CMAKE_FIND_LIBRARY_PREFER_STATIC TRUE)
endif()

find_package(SQLite3 REQUIRED)
find_package(Threads REQUIRED)
find_package(ZLIB REQUIRED)

if(HIER_VIEWER_EXPORTER_FIND_STATIC_DEPS)
  set(CMAKE_FIND_LIBRARY_SUFFIXES ${_HIER_VIEWER_EXPORTER_ORIG_FIND_LIBRARY_SUFFIXES})
  set(CMAKE_FIND_LIBRARY_PREFER_STATIC ${_HIER_VIEWER_EXPORTER_ORIG_FIND_LIBRARY_PREFER_STATIC})
endif()

if(HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR)
  add_subdirectory(${HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR}
                   ${CMAKE_BINARY_DIR}/slang-build)
else()
  include(FetchContent)
  FetchContent_Declare(
    slang
    GIT_REPOSITORY https://github.com/MikePopoloski/slang.git
    GIT_TAG v10.0
    GIT_SHALLOW ON)
  FetchContent_MakeAvailable(slang)
endif()

add_executable(
  slang-hier-exporter
  src/exporter.cpp
  src/filters.cpp
  src/logger.cpp
  src/main.cpp
  src/sqlite_writer.cpp
  src/tree.cpp)

target_include_directories(slang-hier-exporter PRIVATE src)
target_link_libraries(
  slang-hier-exporter
  PRIVATE
    slang::slang
    SQLite::SQLite3
    Threads::Threads
    ZLIB::ZLIB
    ${CMAKE_DL_LIBS})

set_target_properties(
  slang-hier-exporter
  PROPERTIES OUTPUT_NAME "slang-hier-exporter"
             RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/out/bin")

if(CMAKE_SYSTEM_NAME MATCHES "Linux" AND HIER_VIEWER_EXPORTER_FULLY_STATIC)
  target_link_options(slang-hier-exporter PRIVATE -static -static-libstdc++ -static-libgcc)
endif()
