// Логика за интерактивност и модални прозорци
document.addEventListener('DOMContentLoaded', () => {
    console.log("Карадере v0.1 - Инициализиран.");

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

document.addEventListener('DOMContentLoaded', () => {
  const memberModal = document.getElementById('member-modal');
  const memberForm = document.getElementById('member-form');
  const closeMemberModalBtn = document.getElementById('close-member-modal');

  // Отваряне на модала
  document.querySelectorAll('a[href="#membership"], .btn-become-member').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (memberModal) {
        memberModal.classList.add('is-open');
        document.body.style.overflow = 'hidden';
      }
    });
  });

  // Затваряне при клик върху хикса (X)
  if (closeMemberModalBtn) {
    closeMemberModalBtn.addEventListener('click', closeModal);
  }

  // Затваряне при клик извън модалния прозорец
  memberModal.addEventListener('click', (e) => {
    if (e.target === memberModal) {
      closeModal();
    }
  });

  // Затваряне с клавиша Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && memberModal.classList.contains('is-open')) {
      closeModal();
    }
  });

// Функция за затваряне
  function closeModal() {
    if (memberModal) {
      memberModal.classList.remove('is-open');
      document.body.style.overflow = '';
    }
  }

// Обработка на изпращането през FormSubmit
  if (memberForm) {
    memberForm.addEventListener('submit', async function (e) {
    //      e.preventDefault(); // Спираме стандартната форма

        // Вземане на данните от формата
        const formData = new FormData(memberForm);
        const data = Object.fromEntries(formData);

        console.log('Изпратени данни за членство:', data);

        // Тук може да се интегрира Formspree / EmailJS / custom backend
        alert('Благодарим ви! Вашето заявление беше изпратено успешно.');
    //    memberForm.reset();
        closeModal();
    });
  }
});