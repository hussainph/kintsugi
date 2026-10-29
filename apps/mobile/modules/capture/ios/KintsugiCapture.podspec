Pod::Spec.new do |s|
  s.name           = 'KintsugiCapture'
  s.version        = '0.1.0'
  s.summary        = 'Kintsugi capture queue shared with the share extension'
  s.description    = 'App Group capture queue, background delivery and shared pairing for Kintsugi.'
  s.license        = 'UNLICENSED'
  s.author         = 'Kintsugi'
  s.homepage       = 'https://kintsugi.invalid' # local module, never published
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Shared/ is also compiled into the share extension (copied by its plugin).
  s.source_files = '*.swift', 'Shared/*.swift'
  s.exclude_files = 'Tests/**/*'
  s.frameworks = 'Security'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
