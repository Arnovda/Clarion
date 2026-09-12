/**
 * Config schema for the MySQL / MariaDB source connector.
 *
 * No schema selector: in MySQL the database IS the schema, so offering both
 * would be two names for one thing.
 */

import { sqlConfigSchema } from '../sql/configSchema';

export const mysqlConfigSchema = sqlConfigSchema({
  id: 'mysql',
  displayName: 'MySQL',
  defaultPort: 3306,
  schemaField: null,
  sslField: {
    title: 'Use SSL',
    description: 'Required by most managed MySQL services (Azure Database, RDS, PlanetScale).',
  },
});
