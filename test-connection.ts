import * as dotenv from 'dotenv'
import { MyClient } from './src/my-client'

// Lade Variablen aus der .env Datei
dotenv.config()

async function main() {
    console.log('Lade Credentials...')
    const config = {
        baseUrl: process.env.SAP_IAS_BASE_URL,
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
    }

    if (!config.baseUrl || !config.clientId || !config.clientSecret) {
        console.error('❌ Fehler: Es fehlen Variablen in der .env Datei.')
        process.exit(1)
    }

    console.log(`Client ID: ${config.clientId}`)
    console.log(`Base URL:  ${config.baseUrl}`)

    const client = new MyClient(config)

    try {
        console.log('\nStarte testConnection()...')
        const testResult = await client.testConnection()
        console.log('✅ testConnection() erfolgreich:', testResult)

        console.log('\nStarte getAllAccounts()...')
        const accounts = await client.getAllAccounts()
        console.log(`✅ getAllAccounts() erfolgreich: ${accounts.length} Benutzer zurückgegeben.`)
    } catch (err) {
        console.error('\n❌ Fehler bei der Ausführung:', err)
    }
}

main()
