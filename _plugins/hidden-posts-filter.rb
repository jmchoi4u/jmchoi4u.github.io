# Filter out hidden posts before generators render archives, feeds, and pages.
Jekyll::Hooks.register :site, :post_read do |site|
  posts_collection = site.collections["posts"]
  next unless posts_collection&.docs

  visible_docs = posts_collection.docs.reject do |doc|
    value = doc.data["hidden"]
    value == true || value.to_s.downcase == "true"
  end

  posts_collection.docs.replace(visible_docs)
  site.posts.docs.replace(visible_docs) if site.respond_to?(:posts) && site.posts.respond_to?(:docs)
end
