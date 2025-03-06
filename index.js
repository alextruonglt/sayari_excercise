require("dotenv").config()
const fs = require("fs")
const csv = require("csv-parser")
const axios = require("axios")

const SAYARI_API_URL = "https://api.sayari.com/v2/entities"
const OFAC_SANCTIONS_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv"
const OUTPUT_FILE = "enriched_list_2.csv"
const REPORT_FILE = "risk_report.txt"
const WORLD_BANK_API_URL = "https://api.worldbank.org/v2/country/"
const GEOLOCATION_API_URL = "http://api.positionstack.com/v1/forward"

const SAYARI_CLIENT_ID = process.env.SAYARI_CLIENT_ID
const SAYARI_CLIENT_SECRET = process.env.SAYARI_CLIENT_SECRET
const GEOLOCATION_API_KEY = process.env.GEOLOCATION_API_KEY

// Read company names from CSV
const companies = []
fs.createReadStream("list_2.csv")
	.pipe(csv())
	.on("data", (row) => {
		companies.push(row.name)
	})
	.on("end", async () => {
		console.log(`Loaded ${companies.length} companies. Fetching data...`)
		await fetchCompanyData(companies.slice(0, 5)) // Testing with first 5 companies
	})

// Fetch OAuth token from Sayari
async function getSayariAuthToken() {
	try {
		const response = await axios.post("https://api.sayari.com/oauth/token", {
			client_id: SAYARI_CLIENT_ID,
			client_secret: SAYARI_CLIENT_SECRET,
			audience: "sayari.com",
			grant_type: "client_credentials",
		})
		return response.data.access_token
	} catch (error) {
		console.error(
			"Error fetching Sayari API token:",
			error.response?.data || error.message
		)
		return null
	}
}

// Fetch company data from Sayari API
async function fetchSayariData(company) {
	const token = await getSayariAuthToken()
	if (!token) {
		console.error("Failed to get Sayari API token. Skipping request.")
		return null
	}

	try {
		const response = await axios.get(
			"https://api.sayari.com/v1/search/entity",
			{
				headers: { Authorization: `Bearer ${token}` },
				params: { q: company, limit: 1 },
			}
		)
		return response.data.data?.[0] || null
	} catch (error) {
		console.error(
			`Error fetching Sayari data for ${company}:`,
			error.response?.data || error.message
		)
		return null
	}
}

// Function to determine risk level
function calculateRiskLevel(amlRisk, cpiRisk, sanctioned) {
	if (sanctioned === "Yes") return "Very High"
	if (amlRisk > 5 || cpiRisk > 80) return "High"
	if (amlRisk > 3 || cpiRisk > 60) return "Medium"
	return "Low"
}

// Fetch country risk data from World Bank API
async function fetchCountryRisk(countryCode) {
	try {
		const response = await axios.get(
			`${WORLD_BANK_API_URL}${countryCode}/indicator/CC.PER.RNK?format=json`
		)
		return response.data[1]?.[0]?.value ?? "No data found"
	} catch (error) {
		console.error(
			`Error fetching World Bank data for ${countryCode}:`,
			error.message
		)
		return "No data found"
	}
}

// Fetch company location data from Geolocation API
async function fetchCompanyLocation(companyName) {
	try {
		const response = await axios.get(GEOLOCATION_API_URL, {
			params: { access_key: GEOLOCATION_API_KEY, query: companyName },
		})

		if (response.data && response.data.data && response.data.data.length > 0) {
			const lat = response.data.data[0].latitude
			const lon = response.data.data[0].longitude
			return lat && lon ? `${lon}, ${lat}` : "No data found" // Single cell format: "Longitude, Latitude"
		} else {
			return "No data found"
		}
	} catch (error) {
		console.error(
			`Error fetching geolocation data for ${companyName}:`,
			error.message
		)
		return "No data found"
	}
}

// Load and check OFAC Sanctions List
async function loadSanctionsList() {
	try {
		const response = await axios.get(OFAC_SANCTIONS_URL)
		return response.data.split("\n").map((line) => line.split(","))
	} catch (error) {
		console.error("Error fetching OFAC sanctions list:", error.message)
		return []
	}
}

// Process and combine data
async function fetchCompanyData(companies) {
	const sanctionsList = await loadSanctionsList()
	const results = [
		[
			"Company Name",
			"Sayari Entity Name",
			"Sayari Risk Score",
			"AML Risk Score",
			"CPI Risk Score",
			"Negative Media Mentions",
			"OFAC Sanctioned",
			"Country Corruption Rank",
			"Geolocation (Lon, Lat)",
			"Overall Risk Level",
		],
	]
	const reportLines = []
	let highRiskCount = 0,
		sanctionedCount = 0,
		lowMediaMentions = 0

	for (const company of companies) {
		console.log(`Fetching data for: ${company}`)
		const sayariData = await fetchSayariData(company)
		const locationData = await fetchCompanyLocation(company)
		const corruptionRank = sayariData?.countries?.[0]
			? await fetchCountryRisk(sayariData.countries[0])
			: "No data found"
		const isSanctioned = sanctionsList.some(
			(row) => row[0] && row[0].toLowerCase().includes(company.toLowerCase())
		)
			? "Yes"
			: "No"
		const riskScore = sayariData?.risk?.basel_aml?.value || "No data found"
		const amlRiskScore = sayariData?.risk?.basel_aml?.value || "No data found"
		const cpiRiskScore = sayariData?.risk?.cpi_score?.value || "No data found"
		const negativeMedia = sayariData?.negative_media?.length || "No data found"
		const overallRisk = calculateRiskLevel(
			amlRiskScore,
			cpiRiskScore,
			isSanctioned
		)

		if (overallRisk === "High" || overallRisk === "Very High") highRiskCount++
		if (isSanctioned === "Yes") sanctionedCount++
		if (negativeMedia === 0 || negativeMedia === "No data found")
			lowMediaMentions++

		results.push([
			company,
			sayariData?.label || "No data found",
			riskScore,
			amlRiskScore,
			cpiRiskScore,
			negativeMedia,
			isSanctioned,
			corruptionRank,
			locationData,
			overallRisk,
		])
		reportLines.push(
			`Company: ${company}\nRisk Level: ${overallRisk}\nRisk Score: ${riskScore}\nAML Risk Score: ${amlRiskScore}\nCPI Risk Score: ${cpiRiskScore}\nNegative Media Mentions: ${negativeMedia}\nSanctioned: ${isSanctioned}\nCountry Corruption Rank: ${corruptionRank}\nGeolocation: ${locationData}\n----------------------\n`
		)
	}

	// Write to CSV
	fs.writeFileSync(OUTPUT_FILE, results.map((row) => row.join(",")).join("\n"))
	console.log(`Data saved to ${OUTPUT_FILE}`)

	// Append summary to risk report
	reportLines.push(
		"\nSummary:\n" +
			`- ${highRiskCount} out of ${companies.length} companies are classified as HIGH risk due to AML/CPI risk factors.\n` +
			`- ${sanctionedCount} companies are sanctioned.\n` +
			`- ${lowMediaMentions} companies have no negative media mentions, reducing reputational risk.\n`
	)

	fs.writeFileSync(REPORT_FILE, reportLines.join("\n"))
	console.log(`Risk report saved to ${REPORT_FILE}`)
}
