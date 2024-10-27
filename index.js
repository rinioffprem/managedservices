require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const axios = require('axios');
const _ = require('underscore');
const config = require('./config.json');
const emailFilename = './emailtemplate.html';
const nodemailer = require('nodemailer');


const headers = [
    'Client Name', 'Vertical', 'Project Name', 'Budget', 'Monthly Budget',
    'Budget Spent', 'Budget Remaining', '% Used', "% Remaining"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const harvestKey = process.env.HARVEST_KEY;
const harvestAccountId = process.env.HARVEST_ACCOUNT_ID;
const userAgent = `Offprem automated report (scott.rini@offprem.tech)`;


const today = new Date();
const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const firstDayFormatted = firstDayOfMonth.toISOString().split('T')[0];


if (config.send_email) {
    const templateFile = fs.readFileSync(emailFilename, 'utf8');
    emailTemplate = _.template(templateFile);
    mailTransport = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: process.env.MAIL_PORT,
        secure: true,
        auth: {
            user: process.env.MAIL_USERNAME,
            pass: process.env.MAIL_PASSWORD
        }
    });
}
let reportFilename = '';

let logFileName = config.logfile;
if (config.logtimestamp) {
    logFileName += `-${today.toISOString()}`;
}
logFileName += '.txt';
const logFile = fs.createWriteStream(logFileName);

let projects = [];

initialize();
retrieveBudgetReport()
    .catch(ex => {
        debugLog(`Could not fetch buget report: ${ex}`, true);
    });



// Utility functions
function roundDecimal(number) {
    return Math.round((number + Number.EPSILON) * 100) / 100
}

function csvLine(array) {
    array = array.map(element => `"${element}"`);
    return array.join(',') + "\n";
}

function isObject(a) {
    return (!!a) && (a.constructor === Object);
};

function debugLog(message, failure = false) {
    if (config.display_log) {
        console[(failure ? 'log' : 'error')](message);
    }

    logFile.write(message + "\n");
}

// Process functions


function initialize() {
    debugLog('initialize');
    reportFilename = config.output;
    if (config.output_usedate) {
        const toDate = new Date()
        reportFilename += `-${toDate.toISOString().split('T')[0]}`;
    }
    reportFilename += '.csv';

    if (reportFilename == '.csv') {
        debugLog(`Output must be configured.  Received: ${reportFilename}`, true);
        process.exit(1);
    }

}

async function retrieveBudgetReport(page) {
    page = page || 1;
    debugLog(`Fetching budget report page ${page}`);
    const url = `https://api.harvestapp.com/api/v2/reports/project_budget?page=${page}&${config.budget_arguments}`;
    await axios.get(url, {
        headers: {
            Authorization: `Bearer ${harvestKey}`,
            'Harvest-Account-ID': harvestAccountId,
            'User-Agent': userAgent
        }
    }).then(async (res) => {
        res.data.results.forEach(obj => projects.push(obj));

        if (res.data.links && res.data.links.next) {
            // Fetch the next page
            retrieveBudgetReport(page + 1);
        }
        else {
            // We are done, so next steps

            await filterProjects();

            for (let i = 0; i < projects.length; i++) {
                await retrieveProjectCodeForProject(projects[i]);
                await sleep(config.call_delay);
            }

            await finalReport();
            
        }
    }).catch((err) => {
        debugLog(`Could not retrieve budget report: ${err}`, true);
    });
}



async function filterProjects() {
    debugLog('filterProjects');
    // Let's do simple filtering first
// console.log(projects);
    projects = projects.filter(project => project.project_name.toLowerCase().indexOf('managed services') !== -1 && project.budget_is_monthly);
    
}

async function retrieveProjectCodeForProject(project) {
    debugLog(`retrieving project code for project : ${project.client_name} - ${project.project_name}`);
    const projectId = project.project_id;
    const url = `https://api.harvestapp.com/api/v2/projects/${projectId}`;
    await axios.get(url, {
        headers: {
            Authorization: `Bearer ${harvestKey}`,
            'Harvest-Account-ID': harvestAccountId,
            'User-Agent': userAgent
        }
    }).then((res) => {
        project.projectCode = res.data.code || '';

        debugLog(`received ${res.data.code} for ${res.data.name}`);

        
    }).catch((err) => {
        debugLog(`Could not retrieve budget report: ${err}`, true);
    });
}


async function finalReport() {

    const reportFile = fs.createWriteStream(reportFilename);
    reportFile.write(csvLine(headers));
    
    debugLog(`Writing ${projects.length} rows`);
    for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        reportFile.write(csvLine([
            project.client_name, project.projectCode || '', project.project_name, project.budget,
            (project.budget_is_monthly ? 'Y' : 'N'), project.budget_spent,
            project.budget_remaining, roundDecimal((project.budget_spent / project.budget) * 100),
            roundDecimal((project.budget_remaining / project.budget) * 100)
        ]));
    }

    
    reportFile.close();

    if (config.send_email) {
        const mailOptions = {
            from: config.email_from,
            to: config.email_recipient,
            subject: `Managed Services Report`,
            html: emailTemplate({
                firstDayFormatted: firstDayFormatted,
                configuration: JSON.stringify(config, null, 2)
            }),
            attachments: [
                {
                    filename: reportFilename.split('/').slice(-1)[0],
                    path: reportFilename
                }
            ]
        };

        mailTransport.sendMail(mailOptions, (error, info) => {
            if (error) {
                debugLog(error, true);
            }
            else {
                debugLog('Email sent: ' + info.response);
            }
        })
    }

}
