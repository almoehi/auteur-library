/** Where the harness answers.
 *
 *  The golem router matches routes on the request's Host header, and the harness
 *  registers its API under this exact domain — calling 127.0.0.1 or localhost
 *  returns DOMAIN_NOT_REGISTERED even though the port is the same. run.sh adds
 *  the /etc/hosts entry that maps the name back to 127.0.0.1.
 *
 *  Override with AUTEUR_HARNESS_URL if you run the harness somewhere else.
 */
import { env } from '$env/dynamic/private';

export const HARNESS = env.AUTEUR_HARNESS_URL || 'http://host.docker.internal:19006';
