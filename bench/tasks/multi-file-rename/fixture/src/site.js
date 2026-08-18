import { isValidSlug } from './slugify.js'
import { Post } from './post.js'

/** An ordered collection of posts with unique slugs. */
export class Site {
  #posts = []

  /**
   * Add a post; its slug must be unique.
   * @param {string} title - post title.
   * @param {string} body - post body.
   * @returns {Post} the added post.
   */
  addPost(title, body) {
    const post = new Post(title, body)
    if (this.#posts.some((p) => p.slug === post.slug)) {
      throw new Error(`duplicate slug: ${post.slug}`)
    }
    this.#posts.push(post)
    return post
  }

  /**
   * Look up a post by slug.
   * @param {string} slug - slug to find; must already be valid.
   * @returns {Post | undefined} the post, when present.
   */
  findPost(slug) {
    if (!isValidSlug(slug)) return undefined
    return this.#posts.find((p) => p.slug === slug)
  }
}
