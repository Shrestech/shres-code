import { slugify } from './slugify.js'

/** A blog post with a slug derived from its title. */
export class Post {
  /**
   * @param {string} title - display title.
   * @param {string} body - post body text.
   */
  constructor(title, body) {
    this.title = title
    this.body = body
    this.slug = slugify(title)
  }
}
