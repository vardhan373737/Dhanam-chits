// public/script.js
const apiUrl = 'http://localhost:5001/submissions';
let formData = [];

// Function to fetch submissions from the server
async function fetchSubmissions() {
    const response = await fetch(apiUrl);
    formData = await response.json();
    updateTable();
}

// Function to add new submission data to the server
async function addData(event) {
    event.preventDefault(); // Prevent form from submitting normally

    // Get form values
    const name = document.getElementById("name").value;
    const phone = document.getElementById("phone").value;
    const email = document.getElementById("email").value;
    const chitsPlan = document.getElementById("chitsPlan").value;
    const amount = document.getElementById("amount").value;
    const utrNumber = document.getElementById("utrNumber").value;

    // Create new submission object
    const newSubmission = { name, phone, email, chitsPlan, amount, utrNumber };

    // Send the new submission to the server
    await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(newSubmission)
    });

    // Clear the form
    document.getElementById("submission-form").reset();

    // Fetch updated submissions
    fetchSubmissions();
}

// Function to update the table with the current form data
function updateTable() {
    const tableBody = document.getElementById("payments-table");
    tableBody.innerHTML = ''; // Clear current table body

    formData.forEach((payment) => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${payment.name}</td>
            <td>${payment.phone}</td>
            <td>${payment.email}</td>
            <td>${payment.chitsPlan}</td>
            <td>${payment.amount}</td>
            <td>${payment.utrNumber}</td>
            <td><button class="delete-button" onclick="deleteData('${payment._id}')">Delete</button></td>
        `;
        tableBody.appendChild(row);
    });
}

// Function to delete a specific row from the table
async function deleteData(id) {
    await fetch(`${apiUrl}/${id}`, {
        method: 'DELETE'
    });

    // Fetch updated submissions
    fetchSubmissions();
}

// Initialize the page by fetching submissions on load
window.onload = fetchSubmissions;