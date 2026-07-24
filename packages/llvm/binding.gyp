{
  "targets": [
    {
      "target_name": "sonite_llvm",
      "sources": [
        "native/addon.cpp",
        "native/backend.cpp",
        "native/linker.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<!(llvm-config --includedir)"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "SONITE_LLVM_VERSION_EXPECTED=\"22.1.8\""
      ],
      "cflags_cc": [
        "-std=c++17",
        "-fexceptions",
        "-frtti",
        "-Wno-unused-parameter",
        "<!@(llvm-config --cxxflags | tr ' ' '\\n' | grep -v fno-exceptions | grep -v fno-rtti | tr '\\n' ' ')"
      ],
      "libraries": [
        "<!@(llvm-config --ldflags)",
        "<!@(llvm-config --libs)",
        "<!@(llvm-config --system-libs)",
        "-llldELF",
        "-llldMachO",
        "-llldCommon",
        "-lLLVM"
      ],
      "conditions": [
        [
          "OS==\"linux\"",
          {
            "libraries": ["-Wl,-rpath,$ORIGIN"]
          }
        ],
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "11.0"
            }
          }
        ]
      ]
    }
  ]
}
