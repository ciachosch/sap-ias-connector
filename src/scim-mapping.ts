// Central mapping between ISC account attributes and SAP IAS SCIM locations.
// Used by both createAccount (build full resource) and updateAccount (PatchOp paths)
// so the two write paths can never drift apart.

export const SCIM_SCHEMAS = {
    core: 'urn:ietf:params:scim:schemas:core:2.0:User',
    sap: 'urn:ietf:params:scim:schemas:extension:sap:2.0:User',
    enterprise: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    custom: 'urn:sap:cloud:scim:schemas:extension:custom:2.0:User',
    carisma: 'urn:pag:cloud:scim:schemas:extension:carisma:2.0:User',
} as const

type SchemaKey = keyof typeof SCIM_SCHEMAS

interface ScalarMapping {
    schema: SchemaKey
    field: string
    transform?: (v: any) => any
    readOnly?: boolean
}

// SAP IAS expects dateTime, ISC sends date-only — append T00:00:00Z if needed
const toISODateTime = (v: any): any => {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z'
    return v
}

// VCD carries a literal "(none)" placeholder for identities without a mailbox (e.g. many
// retirees). SAP IAS rejects any non-email string with HTTP 400, which fails the WHOLE
// create/update — so only ever forward a value that actually looks like an email.
export const isValidEmail = (v: any): boolean =>
    typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

// SAP IAS enforces a FIXED userType enum and rejects anything else with HTTP 400 —
// which fails the WHOLE account update, including a lifecycle disable/delete.
const IAS_USER_TYPES = new Set([
    'public', 'partner', 'customer', 'employee', 'external',
    'onboardee', 'alumni', 'technical', 'consolidatable',
])

// vwgCommunity → SAP IAS userType. Every value MUST resolve to a member of the enum
// above; a raw unmapped value (e.g. 'retiree', 'resource', 'non-standard') would 400 and
// block disable/delete. retiree→alumni and resource→technical are best-fit and to be
// confirmed with Stephan/Daniel; genuinely unknown values fall back to 'external'.
export const mapUserType = (v: any): any => {
    switch (v) {
        case 'internal':
        case '1':
        case 1:
            return 'employee'
        case 'contractor':
        case 'dealer':
        case '4':
        case 4:
            return 'external'
        case 'retiree':
            return 'alumni'
        case 'resource':
            return 'technical'
        case '6':
        case 6:
            return 'public'
    }
    if (v == null) return v
    // Already a valid IAS type → keep it; otherwise default to a safe valid type.
    if (typeof v === 'string' && IAS_USER_TYPES.has(v.toLowerCase())) return v
    return 'external'
}

// Single-valued attributes that map straight into a (possibly extension) field.
export const SCALAR_ATTRIBUTES: Record<string, ScalarMapping> = {
    displayName: { schema: 'core', field: 'displayName' },
    language: { schema: 'core', field: 'preferredLanguage' },
    timezone: { schema: 'core', field: 'timezone' },
    userType: { schema: 'core', field: 'userType', transform: mapUserType },
    validFrom: { schema: 'sap', field: 'validFrom', transform: toISODateTime },
    validTo: { schema: 'sap', field: 'validTo', transform: toISODateTime },
    sapUserUuid: { schema: 'sap', field: 'userUuid' },
    // loginName is READ-ONLY in SAP IAS — excluded from create, only readable via aggregation
    loginName: { schema: 'sap', field: 'loginName', readOnly: true },
    employeeNumber: { schema: 'enterprise', field: 'employeeNumber' },
    costCenter: { schema: 'enterprise', field: 'costCenter' },
    division: { schema: 'enterprise', field: 'division' },
    organization: { schema: 'enterprise', field: 'organization' },
    manager: { schema: 'custom', field: 'customAttribute7' },
    vwgPersonenStatus: { schema: 'carisma', field: 'vwgPersonStatus' },
    companyCode: { schema: 'carisma', field: 'companyCode' },
    mgmtLevel: { schema: 'carisma', field: 'mgmtLevel' },
    vwgResponsible: { schema: 'carisma', field: 'vwgResponsible' },
    ntprimaryUserAccount: { schema: 'carisma', field: 'ntprimaryUserAccount' },
    cisoLiso: { schema: 'carisma', field: 'CisoLiso' },
    vwgCommunity: { schema: 'carisma', field: 'vwgCommunity' },
}

// Multi-valued / nested core attributes and their PatchOp paths.
const SPECIAL_PATCH_PATHS: Record<string, string> = {
    userName: 'userName',
    active: 'active',
    givenName: 'name.givenName',
    familyName: 'name.familyName',
    email: 'emails[type eq "work"].value',
    externalEmail: 'emails[type eq "other"].value',
    phoneNumber: 'phoneNumbers[type eq "work"].value',
    country: 'addresses[type eq "work"].country',
}

/**
 * Build a SCIM user resource for POST /scim/Users from ISC account attributes.
 * Only attributes that are present (non-null) are written, and only the schema
 * URNs that are actually used end up in the `schemas` array.
 */
export function buildScimCreatePayload(attributes: any): any {
    const usedSchemas = new Set<string>([SCIM_SCHEMAS.core])
    const payload: any = {
        schemas: [],
        userName: attributes.userName ?? attributes.identity,
    }
    if (attributes.active != null) payload.active = attributes.active

    const name: any = {}
    if (attributes.givenName != null) name.givenName = attributes.givenName
    if (attributes.familyName != null) name.familyName = attributes.familyName
    if (Object.keys(name).length) payload.name = name

    const emails: any[] = []
    if (isValidEmail(attributes.email)) emails.push({ value: attributes.email, type: 'work', primary: true })
    if (isValidEmail(attributes.externalEmail))
        emails.push({ value: attributes.externalEmail, type: 'other', primary: false })
    if (emails.length) payload.emails = emails

    if (attributes.phoneNumber != null)
        payload.phoneNumbers = [{ value: attributes.phoneNumber, type: 'work', primary: true }]
    if (attributes.country != null) payload.addresses = [{ country: attributes.country, type: 'work' }]
    if (attributes.x509Certificate != null)
        payload.x509Certificates = [{ value: attributes.x509Certificate, primary: true }]

    for (const [attr, m] of Object.entries(SCALAR_ATTRIBUTES)) {
        if (m.readOnly) continue
        const raw = attributes[attr]
        if (raw == null) continue
        const value = m.transform ? m.transform(raw) : raw
        if (m.schema === 'core') {
            payload[m.field] = value
        } else if (m.schema === 'custom') {
            const urn = SCIM_SCHEMAS.custom
            if (!payload[urn]) payload[urn] = { attributes: [] }
            if (!payload[urn].attributes) payload[urn].attributes = []
            payload[urn].attributes.push({ name: m.field, value })
            usedSchemas.add(urn)
        } else {
            const urn = SCIM_SCHEMAS[m.schema]
            if (!payload[urn]) payload[urn] = {}
            payload[urn][m.field] = value
            usedSchemas.add(urn)
        }
    }

    payload.schemas = [...usedSchemas]
    return payload
}

/**
 * Resolve an ISC account attribute to a SCIM PatchOp path (+ optional value
 * transform). Returns null for attributes we do not provision.
 */
export function attributeToPatch(attribute: string): { path?: string; transform?: (v: any) => any; buildOp?: (value: any) => any } | null {
    if (SPECIAL_PATCH_PATHS[attribute]) return { path: SPECIAL_PATCH_PATHS[attribute] }

    const m = SCALAR_ATTRIBUTES[attribute]
    if (!m) return null

    // SAP IAS custom extension requires the attributes-array format for PATCH
    if (m.schema === 'custom') {
        return {
            transform: m.transform,
            buildOp: (value: any) => ({
                op: 'replace',
                value: { [SCIM_SCHEMAS.custom]: { attributes: [{ name: m.field, value }] } },
            }),
        }
    }

    const path = m.schema === 'core' ? m.field : `${SCIM_SCHEMAS[m.schema]}:${m.field}`
    return { path, transform: m.transform }
}
