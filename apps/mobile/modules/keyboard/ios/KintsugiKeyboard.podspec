Pod::Spec.new do |s|
  s.name           = 'KintsugiKeyboard'
  s.version        = '0.1.0'
  s.summary        = 'Keyboard toolbar and focus for the phone editor WebView'
  s.description    = 'A native inputAccessoryView for the Expo DOM editor WebView, and keyboard on programmatic focus.'
  s.license        = 'UNLICENSED'
  s.author         = 'Kintsugi'
  s.homepage       = 'https://kintsugi.invalid' # local module, never published
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.frameworks = 'WebKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
