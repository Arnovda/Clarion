/** Config schema for the Microsoft SQL Server source connector. */

import { sqlConfigSchema } from '../sql/configSchema';

export const mssqlConfigSchema = sqlConfigSchema({
  id: 'mssql',
  displayName: 'SQL Server',
  defaultPort: 1433,
  schemaField: {
    title: 'Schema',
    description: 'Which schema to read. Defaults to "dbo".',
    default: 'dbo',
  },
  sslField: {
    title: 'Encrypt connection',
    description: 'Required by Azure SQL. Leave off only for an on-premises server that does not support it.',
  },
});
