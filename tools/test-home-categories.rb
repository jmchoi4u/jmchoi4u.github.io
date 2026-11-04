#!/usr/bin/env ruby
# Build the real home template with the category shapes accepted by the editor.
require 'fileutils'
require 'nokogiri'
require 'open3'
require 'tmpdir'
require 'yaml'

root = File.expand_path('..', __dir__)
fixtures = [
  ['nested-writing', ['writing', '에세이'], 'writing', '에세이'],
  ['single-category', ['끄적끄적'], 'writing', '끄적끄적'],
  ['uncategorized', [], 'writing', ''],
  ['nested-dev', ['dev', 'AI활용'], 'dev', 'AI활용'],
  ['group-only', ['writing'], 'writing', ''],
  ['new-category', ['새 분류', '다른 분류'], 'writing', '새 분류'],
  ['reordered-dev', ['개발환경', 'dev'], 'dev', '개발환경']
]

Dir.mktmpdir('home-category-test-') do |source|
  %w[_layouts _posts].each { |dir| FileUtils.mkdir_p(File.join(source, dir)) }
  FileUtils.cp(File.join(root, '_layouts/home.html'), File.join(source, '_layouts/home.html'))
  File.write(File.join(source, 'index.html'), "---\nlayout: home\n---\n")
  config = {
    'theme' => 'jekyll-theme-chirpy', 'lang' => 'ko-KR', 'title' => 'Category test',
    'url' => 'https://example.com', 'timezone' => 'Asia/Seoul',
    'exclude' => ['_site'], 'plugins' => ['jekyll-include-cache']
  }
  File.write(File.join(source, '_config.yml'), config.to_yaml)
  # Use the same includes as the public homepage; the theme supplies the rest.
  FileUtils.mkdir_p(File.join(source, '_includes'))
  %w[post-item.html post-summary.html].each do |name|
    FileUtils.cp(File.join(root, '_includes', name), File.join(source, '_includes', name))
  end
  (fixtures + [['hidden', ['writing'], 'writing', '']]).each do |id, categories, _group, _sub|
    metadata = { 'title' => id, 'categories' => categories, 'permalink' => "/posts/#{id}/" }
    metadata['hidden'] = true if id == 'hidden'
    File.write(File.join(source, '_posts', "2020-01-01-#{id}.md"), metadata.to_yaml + "---\nFixture body.\n")
  end
  output, status = Open3.capture2e(
    { 'JEKYLL_ENV' => 'test' }, 'bundle', 'exec', 'jekyll', 'build',
    '--source', source, '--destination', File.join(source, '_site'),
    '--config', File.join(source, '_config.yml'), chdir: root
  )
  abort output unless status.success?
  page = Nokogiri::HTML(File.read(File.join(source, '_site/index.html')))
  cards = page.css('[data-home-post]')
  raise 'Hidden posts must stay out of the home feed' unless cards.size == fixtures.size

  tab = lambda do |group, sub|
    page.css('[data-cat-link]').find { |node| node['data-cat-group'] == group && node['data-cat-sub'] == sub }
  end
  count_of = ->(link) { link.at_css('.jm-cat-count').text.to_i }

  fixtures.each do |id, _categories, group, sub|
    card = cards.find { |node| node.at_css('a')['href'] == "/posts/#{id}/" }
    raise "Missing card: #{id}" unless card
    raise "Wrong home group for #{id}: #{card['data-home-group']}" unless card['data-home-group'] == group
    raise "Wrong subcategory for #{id}: #{card['data-home-sub']}" unless card['data-home-sub'] == sub
    raise "#{id} must be visible before any category is picked" if card.key?('hidden')
    # Each writing sub-category gets its own tab; the dev shelf is one tab.
    next if sub.empty? || group == 'dev'

    link = tab.call(group, sub)
    raise "Missing category tab for #{id}" unless link
    expected = fixtures.count { |fixture| fixture[2] == group && fixture[3] == sub }
    raise "Incorrect #{sub} count: #{count_of.call(link)}, expected #{expected}" unless count_of.call(link) == expected
  end

  all = tab.call('all', 'all')
  raise "Incorrect total: #{all && count_of.call(all)}, expected #{fixtures.size}" unless all && count_of.call(all) == fixtures.size
  dev = tab.call('dev', 'all')
  dev_count = fixtures.count { |fixture| fixture[2] == 'dev' }
  raise "Incorrect dev count: #{dev && count_of.call(dev)}, expected #{dev_count}" unless dev && count_of.call(dev) == dev_count
end

puts 'Home category rendering passed: single, nested, empty, new, reordered, and hidden categories.'
