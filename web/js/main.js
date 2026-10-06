// Логика за интерактивност и модални прозорци
document.addEventListener('DOMContentLoaded', () => {
    console.log("Черноморски Отпечатък v0.1 - Инициализиран.");

    // Мобилно меню
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');

    if (mobileMenuBtn && mobileMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            mobileMenu.classList.toggle('hidden');
        });
    }
});

// Функция за отваряне на модал за дарения
function openDonateModal(amount = '') {
    const modal = document.getElementById('donate-modal');
    if (modal) {
        modal.classList.remove('hidden');
        if (amount) {
            const customInput = document.getElementById('custom-amount');
            if (customInput) customInput.value = amount;
        }
    }
}

// Функция за затваряне на модали
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('hidden');
    }
}